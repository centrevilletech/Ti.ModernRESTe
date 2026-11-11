#!/usr/bin/env node
'use strict';

/**
 * A small HTTP server that behaves like the APIs RESTe has to cope with: pages, cursors, ETags, 401 / 426 /
 * 429, slow and dropped responses, idempotency keys, multipart uploads, a CRUD resource.
 *
 * Used by the integration tests (started in-process on a free port) and by the example app
 * (`npm run server`, then `adb reverse tcp:8787 tcp:8787` for an Android device).
 *
 *   const server = await start({ port: 0 });   server.url, server.stats, server.reset(), await server.close()
 */
const http = require('http');
const crypto = require('crypto');

const ITEM_COUNT = 45;

function makeItems(count) {
	const items = [];
	for (let i = 1; i <= count; i++) {
		items.push({ id: i, title: 'Item ' + i, done: i % 3 === 0, tags: ['t' + (i % 4)], owner: { id: i % 5, name: 'Owner ' + (i % 5) } });
	}
	return items;
}

function freshState() {
	return {
		items: makeItems(ITEM_COUNT),
		messages: makeItems(100).map(item => ({ id: item.id, text: 'Message ' + item.id })),
		things: [{ id: 1, name: 'First', count: 1 }, { id: 2, name: 'Second', count: 2 }, { id: 3, name: 'Third', count: 3 }],
		nextThingId: 4,
		catalogVersion: 1,
		orders: new Map(), // idempotency key -> stored response
		ordersCreated: 0,
		flaky: new Map(), // key -> failures so far
		limited: 0,
		token: 'good-token',
		refreshes: 0,
		hits: {}
	};
}

function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		request.on('data', chunk => chunks.push(chunk));
		request.on('end', () => resolve(Buffer.concat(chunks)));
		request.on('error', reject);
	});
}

/** A minimal multipart/form-data parser: enough to prove what a client sent. */
function parseMultipart(buffer, contentType) {
	const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
	if (!match) {
		return null;
	}
	const boundary = Buffer.from('--' + (match[1] || match[2]));
	const fields = {};
	const files = {};
	let start = buffer.indexOf(boundary);
	while (start !== -1) {
		const next = buffer.indexOf(boundary, start + boundary.length);
		if (next === -1) {
			break;
		}
		const part = buffer.slice(start + boundary.length + 2, next - 2); // strip CRLF around the part
		const split = part.indexOf('\r\n\r\n');
		if (split !== -1) {
			const head = part.slice(0, split).toString('utf8');
			const content = part.slice(split + 4);
			const name = (/name="([^"]*)"/i.exec(head) || [])[1];
			const filename = (/filename="([^"]*)"/i.exec(head) || [])[1];
			const type = (/content-type:\s*([^\r\n]+)/i.exec(head) || [])[1];
			if (name !== undefined) {
				if (filename !== undefined) {
					files[name] = {
						filename, type: type || null, size: content.length,
						sha1: crypto.createHash('sha1').update(content).digest('hex')
					};
				} else {
					fields[name] = content.toString('utf8');
				}
			}
		}
		start = next;
	}
	return { fields, files };
}

function start(options) {
	const settings = options || {};
	let state = freshState();
	const sockets = new Set();

	function send(response, status, body, headers) {
		const text = body === undefined || body === null ? '' : JSON.stringify(body);
		const out = Object.assign({}, headers);
		if (text) {
			out['Content-Type'] = out['Content-Type'] || 'application/json';
		}
		out['Content-Length'] = Buffer.byteLength(text);
		response.writeHead(status, out);
		response.end(text);
	}

	async function handle(request, response) {
		const url = new URL(request.url, 'http://localhost');
		const path = url.pathname;
		const query = url.searchParams;
		const method = request.method;
		const key = method + ' ' + path;
		state.hits[key] = (state.hits[key] || 0) + 1;
		const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(request);
		let json = null;
		if (raw.length && /json/i.test(request.headers['content-type'] || '')) {
			try {
				json = JSON.parse(raw.toString('utf8'));
			} catch (error) {
				send(response, 400, { message: 'invalid JSON' });
				return;
			}
		}

		if (path === '/_reset') {
			state = freshState();
			send(response, 200, { ok: true });
			return;
		}
		if (path === '/_stats') {
			send(response, 200, { hits: state.hits, ordersCreated: state.ordersCreated, refreshes: state.refreshes });
			return;
		}
		if (path === '/health') {
			send(response, 200, { ok: true });
			return;
		}

		// ---- page / per_page
		if (path === '/items' && method === 'GET') {
			const perPage = Math.min(50, parseInt(query.get('per_page') || '10', 10));
			const page = parseInt(query.get('page') || '1', 10);
			const all = query.get('done') === null ? state.items : state.items.filter(item => String(item.done) === query.get('done'));
			const lastPage = Math.max(1, Math.ceil(all.length / perPage));
			send(response, 200, {
				data: all.slice((page - 1) * perPage, page * perPage),
				meta: { current_page: page, per_page: perPage, total: all.length, last_page: lastPage }
			});
			return;
		}
		if (path === '/big' && method === 'GET') {
			const count = parseInt(query.get('count') || '500', 10);
			const changed = parseInt(query.get('changed') || '0', 10);
			const items = makeItems(count);
			for (let i = 0; i < changed; i++) {
				items[i].title += ' (edited ' + (query.get('rev') || '1') + ')';
			}
			send(response, 200, { data: items, meta: { total: count } });
			return;
		}

		// ---- cursors: before / after (ids ascending) with has_more
		if (path === '/messages' && method === 'GET') {
			const limit = Math.min(50, parseInt(query.get('limit') || '20', 10));
			const before = query.get('before');
			const after = query.get('after');
			let page;
			let hasMore;
			if (after !== null) {
				const newer = state.messages.filter(message => message.id > Number(after));
				page = newer.slice(0, limit);
				hasMore = newer.length > limit;
			} else {
				const older = before === null ? state.messages : state.messages.filter(message => message.id < Number(before));
				page = older.slice(Math.max(0, older.length - limit));
				hasMore = older.length > limit;
			}
			send(response, 200, { data: page, meta: { has_more: hasMore } });
			return;
		}
		if (path === '/messages' && method === 'POST') {
			const message = { id: state.messages[state.messages.length - 1].id + 1, text: (json && json.text) || '' };
			state.messages.push(message);
			send(response, 201, { data: message });
			return;
		}
		// ---- cursors: an opaque token
		if (path === '/feed' && method === 'GET') {
			const size = 10;
			const offset = query.get('cursor') ? parseInt(Buffer.from(query.get('cursor'), 'base64').toString(), 10) : 0;
			const page = state.items.slice(offset, offset + size);
			const next = offset + size < state.items.length ? Buffer.from(String(offset + size)).toString('base64') : null;
			send(response, 200, { items: page, next_cursor: next });
			return;
		}

		// ---- conditional GET
		if (path === '/catalog' && method === 'GET') {
			const etag = '"catalog-v' + state.catalogVersion + '"';
			if (request.headers['if-none-match'] === etag) {
				response.writeHead(304, { ETag: etag });
				response.end();
				return;
			}
			send(response, 200, { data: [{ id: 1, name: 'Basic' }, { id: 2, name: 'Plus' }], version: state.catalogVersion }, { ETag: etag });
			return;
		}
		if (path === '/catalog/bump' && method === 'POST') {
			state.catalogVersion++;
			send(response, 200, { version: state.catalogVersion });
			return;
		}
		if (path === '/settings' && method === 'GET') {
			send(response, 200, { data: { theme: 'light', served: state.hits[key] } }, { 'Cache-Control': 'max-age=' + (query.get('max_age') || '60') });
			return;
		}

		// ---- status codes
		if (path === '/secure' && method === 'GET') {
			if (request.headers.authorization !== 'Bearer ' + state.token) {
				send(response, 401, { code: 'UNAUTHENTICATED', message: 'Sign in again.' });
				return;
			}
			send(response, 200, { data: { secret: 42 } });
			return;
		}
		if (path === '/token/rotate' && method === 'POST') {
			state.token = 'token-' + (++state.refreshes);
			send(response, 200, { token: state.token });
			return;
		}
		if (path === '/token/expire' && method === 'POST') {
			state.token = 'expired-' + Date.now();
			send(response, 200, { ok: true });
			return;
		}
		if (path === '/upgrade') {
			send(response, 426, { code: 'APP_UPDATE_REQUIRED', message: 'Update the app.' });
			return;
		}
		if (path === '/limited') {
			state.limited++;
			const allow = parseInt(query.get('after') || '2', 10);
			if (state.limited <= allow) {
				send(response, 429, { code: 'RATE_LIMITED', message: 'Slow down.' }, { 'Retry-After': query.get('retry_after') || '1' });
				return;
			}
			send(response, 200, { data: { attempts: state.limited } });
			return;
		}
		if (path === '/invalid' && method === 'POST') {
			send(response, 422, { code: 'VALIDATION_FAILED', message: 'The name is required.', errors: { name: ['The name is required.'] } });
			return;
		}
		if (path === '/broken-json') {
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end('{"data": [1, 2,');
			return;
		}
		if (path === '/html') {
			response.writeHead(502, { 'Content-Type': 'text/html' });
			response.end('<html><body>Bad gateway</body></html>');
			return;
		}
		if (path === '/empty') {
			response.writeHead(204);
			response.end();
			return;
		}

		// ---- slow, dropped, flaky
		if (path === '/slow') {
			const ms = parseInt(query.get('ms') || '1000', 10);
			setTimeout(() => {
				if (!response.destroyed) {
					send(response, 200, { data: { waited: ms } });
				}
			}, ms);
			return;
		}
		if (path === '/drop') {
			request.socket.destroy();
			return;
		}
		if (path === '/flaky') {
			const name = query.get('key') || 'default';
			const failures = parseInt(query.get('fail') || '2', 10);
			const seen = state.flaky.get(name) || 0;
			state.flaky.set(name, seen + 1);
			if (seen < failures) {
				if (query.get('mode') === 'drop') {
					request.socket.destroy();
				} else {
					send(response, 503, { code: 'SERVICE_UNAVAILABLE', message: 'Try again.' });
				}
				return;
			}
			send(response, 200, { data: { attempts: seen + 1 } });
			return;
		}

		// ---- bodies
		if (path === '/echo') {
			send(response, 200, {
				method,
				path,
				query: Object.fromEntries(query.entries()),
				rawQuery: url.search,
				headers: request.headers,
				json,
				text: json ? null : raw.toString('utf8')
			});
			return;
		}
		if (path === '/orders' && method === 'POST') {
			const idempotencyKey = request.headers['idempotency-key'];
			if (idempotencyKey && state.orders.has(idempotencyKey)) {
				send(response, 201, state.orders.get(idempotencyKey), { 'Idempotent-Replayed': 'true' });
				return;
			}
			state.ordersCreated++;
			const order = { data: { id: state.ordersCreated, item: json && json.item, key: idempotencyKey || null } };
			if (idempotencyKey) {
				state.orders.set(idempotencyKey, order);
			}
			if (query.get('lose') === 'first' && state.ordersCreated === 1) {
				request.socket.destroy(); // the order was created, the client never hears about it
				return;
			}
			send(response, 201, order);
			return;
		}
		if (path === '/upload' && method === 'POST') {
			const parsed = parseMultipart(raw, request.headers['content-type']);
			if (!parsed) {
				send(response, 415, { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'multipart/form-data expected', got: request.headers['content-type'] || null });
				return;
			}
			if (request.headers['x-token'] !== undefined && request.headers['x-token'] !== 'upload-ok') {
				send(response, 401, { code: 'UNAUTHENTICATED' });
				return;
			}
			send(response, 201, {
				data: { fields: parsed.fields, files: parsed.files, bytes: raw.length, idempotencyKey: request.headers['idempotency-key'] || null }
			});
			return;
		}
		if (path.indexOf('/download/') === 0 && method === 'GET') {
			const size = parseInt(path.split('/')[2], 10) || 1024;
			const body = Buffer.alloc(size, 'r');
			response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size });
			// Sent in pieces so a client can report progress and cancel half-way.
			let offset = 0;
			const piece = Math.max(1024, Math.ceil(size / 20));
			const timer = setInterval(() => {
				if (response.destroyed) {
					clearInterval(timer);
					return;
				}
				response.write(body.slice(offset, offset + piece));
				offset += piece;
				if (offset >= size) {
					clearInterval(timer);
					response.end();
				}
			}, parseInt(query.get('pace') || '5', 10));
			return;
		}

		// ---- a CRUD resource
		const thingMatch = /^\/things(?:\/(\d+))?$/.exec(path);
		if (thingMatch) {
			const id = thingMatch[1] ? Number(thingMatch[1]) : null;
			const index = id === null ? -1 : state.things.findIndex(thing => thing.id === id);
			if (query.get('fail')) {
				send(response, Number(query.get('fail')), { code: 'REFUSED', message: 'The server refused this change.' });
				return;
			}
			if (method === 'GET' && id === null) {
				send(response, 200, { data: state.things });
				return;
			}
			if (method === 'POST' && id === null) {
				if (!json || !json.name) {
					send(response, 422, { code: 'VALIDATION_FAILED', message: 'The name is required.', errors: { name: ['The name is required.'] } });
					return;
				}
				const thing = Object.assign({}, json, { id: state.nextThingId++ });
				state.things.push(thing);
				send(response, 201, { data: thing });
				return;
			}
			if (id !== null && index === -1) {
				send(response, 404, { code: 'NOT_FOUND', message: 'No such thing.' });
				return;
			}
			if (method === 'GET') {
				send(response, 200, { data: state.things[index] });
				return;
			}
			if (method === 'PUT') {
				state.things[index] = Object.assign({}, json, { id });
				send(response, 200, { data: state.things[index] });
				return;
			}
			if (method === 'PATCH') {
				state.things[index] = Object.assign({}, state.things[index], json, { id });
				send(response, 200, { data: state.things[index] });
				return;
			}
			if (method === 'DELETE') {
				state.things.splice(index, 1);
				response.writeHead(204, raw.length ? { 'X-Had-Body': 'true' } : {});
				response.end();
				return;
			}
		}

		send(response, 404, { code: 'NOT_FOUND', message: 'No route for ' + key });
	}

	const server = http.createServer((request, response) => {
		handle(request, response).catch((error) => {
			if (!response.headersSent) {
				send(response, 500, { code: 'SERVER_ERROR', message: error.message });
			}
		});
	});
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});

	return new Promise((resolve, reject) => {
		server.on('error', reject);
		server.listen(settings.port || 0, settings.host || '127.0.0.1', () => {
			const port = server.address().port;
			resolve({
				port,
				url: 'http://127.0.0.1:' + port + '/',
				get stats() {
					return state;
				},
				reset() {
					state = freshState();
				},
				close() {
					sockets.forEach(socket => socket.destroy());
					return new Promise(done => server.close(done));
				}
			});
		});
	});
}

module.exports = { start, makeItems, ITEM_COUNT };

if (require.main === module) {
	const portFlag = process.argv.indexOf('--port');
	const port = portFlag !== -1 ? parseInt(process.argv[portFlag + 1], 10) : 8787;
	const host = process.argv.includes('--public') ? '0.0.0.0' : '127.0.0.1';
	start({ port, host }).then((server) => {
		console.log('RESTe test server on http://' + host + ':' + server.port + '/');
	});
}
