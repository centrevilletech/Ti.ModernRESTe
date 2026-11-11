'use strict';

/*
 * RESTe against a real HTTP server over real sockets: the Titanium HTTP client is replaced by a Node-backed
 * one with the same interface (test/helpers/node-http.js), everything else is the library as shipped.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const Reste = require('../helpers/reste');
const { installFakeTi, wait } = require('../helpers/ti');
const { createNodeHttpClient } = require('../helpers/node-http');
const { load, installAlloy, uninstallAlloy } = require('../helpers/backbone');
const { start } = require('../server/server');

const METHODS = [
	{ name: 'health', get: 'health' },
	{ name: 'items', get: 'items', paginate: { style: 'page', perPage: 10 } },
	{ name: 'messages', get: 'messages', paginate: { style: 'cursor', limit: 20 } },
	{ name: 'sendMessage', post: 'messages' },
	{ name: 'feed', get: 'feed', unwrap: false, paginate: { style: 'cursor', cursorParam: 'cursor', nextCursor: 'next_cursor', items: 'items', order: 'desc' } },
	{ name: 'catalog', get: 'catalog', cache: 'etag' },
	{ name: 'bumpCatalog', post: 'catalog/bump', invalidates: [] },
	{ name: 'settings', get: 'settings', cache: true },
	{ name: 'secure', get: 'secure' },
	{ name: 'rotate', post: 'token/rotate', statusHooks: false, session: false },
	{ name: 'upgrade', get: 'upgrade' },
	{ name: 'limited', get: 'limited' },
	{ name: 'invalid', post: 'invalid' },
	{ name: 'brokenJson', get: 'broken-json' },
	{ name: 'html', get: 'html' },
	{ name: 'empty', get: 'empty' },
	{ name: 'slow', get: 'slow' },
	{ name: 'drop', get: 'drop' },
	{ name: 'flaky', get: 'flaky' },
	{ name: 'echo', post: 'echo', unwrap: false },
	{ name: 'echoGet', get: 'echo', unwrap: false },
	{ name: 'echoDelete', delete: 'echo', unwrap: false },
	{ name: 'echoForm', post: 'echo', form: true, unwrap: false },
	{ name: 'order', post: 'orders', idempotent: true },
	{ name: 'upload', post: 'upload', multipart: true },
	{ name: 'download', get: 'download/<size>', download: true },
	{ name: 'getThings', get: 'things' },
	{ name: 'getThing', get: 'things/<id>' },
	{ name: 'createThing', post: 'things' },
	{ name: 'updateThing', put: 'things/<id>' },
	{ name: 'patchThing', patch: 'things/<id>' },
	{ name: 'deleteThing', delete: 'things/<id>' },
	{ name: 'stats', get: '_stats', unwrap: false }
];

describe('against a real HTTP server', () => {
	let server;
	let ti;
	let api;

	before(async () => {
		server = await start({ port: 0 });
	});
	after(async () => {
		await server.close();
	});
	beforeEach(() => {
		server.reset();
		ti = installFakeTi();
		api = new Reste();
		configure();
	});
	afterEach(() => {
		api.abortAll();
		ti.uninstall();
		uninstallAlloy();
	});

	function configure(extra) {
		api.config(Object.assign({
			url: server.url,
			httpClient: createNodeHttpClient,
			unwrap: 'data',
			meta: 'meta',
			timeout: 2000,
			methods: METHODS
		}, extra));
	}

	async function rejection(promise) {
		try {
			await promise;
		} catch (error) {
			return error;
		}
		throw new Error('expected a rejection');
	}

	describe('requests', () => {
		it('GETs JSON', async () => {
			assert.deepEqual(await api.health(), { ok: true });
		});

		it('sends JSON bodies, query strings and headers as the server expects them', async () => {
			const echoed = await api.echo({ body: { name: 'Ünï', n: [1, 2] }, query: { tags: ['a', 'b'], q: 'x y', none: null } }, { headers: { 'X-Trace': 'abc' } });
			assert.deepEqual(echoed.json, { name: 'Ünï', n: [1, 2] });
			assert.equal(echoed.headers['content-type'], 'application/json');
			assert.equal(echoed.headers['x-trace'], 'abc');
			assert.deepEqual(echoed.query, { 'tags[]': 'b', q: 'x y' });
			assert.equal(echoed.rawQuery, '?tags%5B%5D=a&tags%5B%5D=b&q=x%20y');
		});

		it('sends DELETE with and without a body', async () => {
			assert.equal((await api.echoDelete()).text, '');
			assert.deepEqual((await api.echoDelete({ body: { reason: 'x' } })).json, { reason: 'x' });
		});

		it('form-encodes', async () => {
			const echoed = await api.echoForm({ body: { user: 'a b', remember: true } });
			assert.equal(echoed.headers['content-type'], 'application/x-www-form-urlencoded');
			assert.equal(echoed.text, 'user=a%20b&remember=true');
		});

		it('handles 204 and non-JSON bodies', async () => {
			assert.equal(await api.empty(), null);
			const error = await rejection(api.html());
			assert.equal(error.status, 502);
			assert.match(error.body, /Bad gateway/);
		});

		it('reports truncated JSON as a parse error', async () => {
			const error = await rejection(api.brokenJson());
			assert.equal(error.kind, 'parse');
		});

		it('gives validation errors with their parsed body and maps them', async () => {
			configure({ mapError: error => (error.body && error.body.code ? { code: error.body.code, fields: error.body.errors, status: error.status } : error) });
			assert.deepEqual(await rejection(api.invalid({ body: {} })), { code: 'VALIDATION_FAILED', fields: { name: ['The name is required.'] }, status: 422 });
		});
	});

	describe('pages and cursors', () => {
		it('walks page/per_page to the end', async () => {
			const pager = api.paginate('items', { perPage: 20 });
			const seen = [];
			while (pager.hasMore) {
				const page = await pager.next();
				seen.push(page.items.length);
			}
			assert.deepEqual(seen, [20, 20, 5]);
			assert.equal(pager.total, 45);
			assert.equal(pager.items.length, 45);
			assert.equal(new Set(pager.items.map(item => item.id)).size, 45);
		});

		it('filters travel with every page', async () => {
			const pager = api.paginate('items', { query: { done: true }, perPage: 10 });
			await pager.next();
			await pager.next();
			assert.equal(pager.total, 15);
			assert.equal(pager.items.every(item => item.done === true), true);
			assert.equal(pager.hasMore, false);
		});

		it('pages back through before/after cursors and picks up new messages', async () => {
			const pager = api.paginate('messages');
			await pager.next();
			assert.deepEqual([pager.items[0].id, pager.items[pager.items.length - 1].id], [81, 100]);
			await pager.next();
			assert.equal(pager.items[0].id, 61);
			await api.sendMessage({ body: { text: 'hello' } });
			const newer = await pager.previous();
			assert.deepEqual(newer.items.map(item => item.text), ['hello']);
			while (pager.hasMore) {
				await pager.next();
			}
			assert.equal(pager.items.length, 101);
			assert.deepEqual(pager.items.map(item => item.id), Array.from({ length: 101 }, (unused, index) => index + 1));
		});

		it('follows opaque cursor tokens', async () => {
			const pager = api.paginate('feed');
			let pages = 0;
			while (pager.hasMore) {
				await pager.next();
				pages++;
			}
			assert.equal(pages, 5);
			assert.equal(pager.items.length, 45);
		});
	});

	describe('conditional requests and caching', () => {
		it('revalidates with the ETag, gets 304, and notices a new version', async () => {
			const first = await api.catalog({}, { fullResponse: true });
			const second = await api.catalog({}, { fullResponse: true });
			assert.equal(first.fromCache, false);
			assert.equal(second.notModified, true);
			assert.equal(second.data, first.data);
			await api.bumpCatalog();
			const third = await api.catalog({}, { fullResponse: true });
			assert.equal(third.notModified, false);
			assert.equal(third.body.version, 2);
			const stats = await api.stats();
			assert.equal(stats.hits['GET /catalog'], 3);
		});

		it('serves from memory within max-age', async () => {
			const first = await api.settings();
			const second = await api.settings();
			assert.equal(second, first);
			assert.equal((await api.stats()).hits['GET /settings'], 1);
		});
	});

	describe('status handling', () => {
		it('401: one "session ended" for a burst, and a token refresh that retries every request', async () => {
			let token = 'wrong';
			let ended = 0;
			configure({
				requestHeaders: { Authorization: () => 'Bearer ' + token },
				onStatus: {
					401: () => {
						ended++;
						return api.rotate().then((fresh) => {
							token = fresh.token;
							return 'retry';
						});
					}
				}
			});
			const results = await Promise.all([api.secure(), api.secure(), api.secure()]);
			assert.deepEqual(results, [{ secret: 42 }, { secret: 42 }, { secret: 42 }]);
			assert.equal(ended, 1);
			assert.equal(server.stats.refreshes, 1);
		});

		it('401 without a refresh rejects every request and fires once', async () => {
			let ended = 0;
			configure({ onStatus: { 401: () => { ended++; } } });
			const errors = await Promise.all([rejection(api.secure()), rejection(api.secure())]);
			assert.deepEqual(errors.map(error => [error.status, error.body.code]), [[401, 'UNAUTHENTICATED'], [401, 'UNAUTHENTICATED']]);
			assert.equal(ended, 1);
		});

		it('426 reaches its hook', async () => {
			const seen = [];
			configure({ onStatus: { 426: error => seen.push(error.body.code) } });
			await rejection(api.upgrade());
			assert.deepEqual(seen, ['APP_UPDATE_REQUIRED']);
		});

		it('429 carries Retry-After, and a policy that allows it waits and succeeds', async () => {
			const error = await rejection(api.limited({ query: { after: 1, retry_after: 1 } }));
			assert.equal(error.status, 429);
			assert.equal(error.retryAfter, 1000);
			server.reset();
			configure({ retry: { retries: 2, baseDelay: 5, jitter: 0, statuses: [429], maxRetryAfter: 80 } });
			const started = Date.now();
			const data = await api.limited({ query: { after: 2, retry_after: 1 } });
			assert.equal(data.attempts, 3);
			assert.ok(Date.now() - started >= 150, 'honoured Retry-After (capped) twice');
		});
	});

	describe('slow, dropped and flaky responses', () => {
		it('times out', async () => {
			const error = await rejection(api.slow({ query: { ms: 400 } }, { timeout: 60 }));
			assert.equal(error.kind, 'timeout');
			assert.equal(error.status, 0);
		});

		it('reports a dropped connection as a network error', async () => {
			const error = await rejection(api.drop());
			assert.equal(error.kind, 'network');
		});

		it('retries a flaky GET through 503s and through dropped connections', async () => {
			configure({ retry: { retries: 3, baseDelay: 5, jitter: 0 } });
			assert.deepEqual(await api.flaky({ query: { key: 'a', fail: 2 } }), { attempts: 3 });
			assert.deepEqual(await api.flaky({ query: { key: 'b', fail: 2, mode: 'drop' } }), { attempts: 3 });
		});

		it('can be cancelled mid-flight', async () => {
			const handle = api.slow({ query: { ms: 500 } });
			await wait(30);
			handle.abort();
			assert.equal((await rejection(handle)).kind, 'cancelled');
		});

		it('an order whose response is lost is not created twice: the retry replays by idempotency key', async () => {
			configure({ retry: { retries: 2, baseDelay: 5, jitter: 0 } });
			const handle = api.order({ body: { item: 'coffee' }, query: { lose: 'first' } }, { fullResponse: true });
			const response = await handle;
			assert.equal(response.header('Idempotent-Replayed'), 'true');
			assert.equal(response.data.key, handle.idempotencyKey);
			assert.equal(response.attempts, 2);
			assert.equal(server.stats.ordersCreated, 1);
		});
	});

	describe('uploads and downloads', () => {
		it('uploads files and fields as multipart/form-data and the server reads them back', async () => {
			const bytes = crypto.randomBytes(64 * 1024);
			const photo = ti.createBlob(bytes, 'image/jpeg', 'photo.jpg');
			const note = ti.createBlob('plain text', 'text/plain', 'note.txt');
			const progress = [];
			const result = await api.upload({ body: { photo, 'documents[]': [note], caption: 'Front door', tags: ['a', 'b'] } }, { onProgress: value => progress.push(value) });
			assert.deepEqual(result.fields, { caption: 'Front door', 'tags[0]': 'a', 'tags[1]': 'b' });
			assert.equal(result.files.photo.size, bytes.length);
			assert.equal(result.files.photo.type, 'image/jpeg');
			assert.equal(result.files.photo.sha1, crypto.createHash('sha1').update(bytes).digest('hex'));
			assert.equal(result.files['documents[0]'].filename, 'note.txt');
			assert.ok(progress.length >= 2);
			assert.equal(progress[progress.length - 1], 1);
			assert.ok(progress.every((value, index) => index === 0 || value >= progress[index - 1]));
		});

		it('an upload goes through headers and the error pipeline like any request', async () => {
			configure({ requestHeaders: { 'Content-Type': 'application/json', 'X-Token': 'wrong' }, mapError: error => ({ code: error.body.code }) });
			assert.deepEqual(await rejection(api.upload({ body: { f: ti.createBlob('x') } })), { code: 'UNAUTHENTICATED' });
		});

		it('cancels an upload', async () => {
			const big = ti.createBlob(crypto.randomBytes(4 * 1024 * 1024), 'application/octet-stream', 'big.bin');
			const handle = api.upload({ body: { big } });
			await wait(1);
			handle.abort();
			assert.equal((await rejection(handle)).kind, 'cancelled');
		});

		it('downloads to a file with progress', async () => {
			const file = ti.Ti.Filesystem.getFile('/cache/download.bin');
			const progress = [];
			const response = await api.download({ size: 200000 }, { file, onProgress: value => progress.push(value), fullResponse: true });
			assert.equal(response.file, file);
			assert.equal(file.read().buffer.length, 200000);
			assert.ok(progress.length > 3);
			assert.equal(progress[progress.length - 1], 1);
		});

		it('cancels a download half-way', async () => {
			const file = ti.Ti.Filesystem.getFile('/cache/partial.bin');
			let handle = null;
			handle = api.download({ size: 400000, query: { pace: 10 } }, {
				file,
				onProgress: (value) => {
					if (value > 0.3) {
						handle.abort();
					}
				}
			});
			assert.equal((await rejection(handle)).kind, 'cancelled');
			assert.equal(file.exists(), false);
		});
	});

	['0.9.2', '1.4.0', '1.6.0'].forEach((version) => {
		describe('models and collections over HTTP, Backbone ' + version, () => {
			beforeEach(() => {
				installAlloy(load(version));
				configure({
					models: [{
						name: 'thing',
						read: 'getThing',
						create: 'createThing',
						update: 'updateThing',
						patch: 'patchThing',
						delete: 'deleteThing',
						content: 'data',
						collections: [{ name: 'things', read: 'getThings', content: 'data', merge: true }, { name: 'pagedItems', read: 'items', content: 'data', merge: true }]
					}]
				});
			});

			it('fetches, creates, updates, patches and deletes', async () => {
				const things = Alloy.Collections.things;
				await things.fetch();
				assert.deepEqual(things.pluck('name'), ['First', 'Second', 'Third']);

				const created = things.create({ name: 'Fourth', count: 4 }, { wait: true });
				await wait(60);
				assert.equal(created.id, 4);
				assert.equal(things.length, 4);

				await created.save({ name: 'Fourth!', count: 4 });
				assert.equal(server.stats.things[3].name, 'Fourth!');

				await things.get(1).save({ count: 10 }, { patch: true });
				assert.deepEqual(server.stats.things[0], { id: 1, name: 'First', count: 10 });

				await things.get(2).destroy({ wait: true });
				assert.equal(things.length, 3);
				assert.deepEqual(server.stats.things.map(thing => thing.id), [1, 3, 4]);

				const loaded = api.createModel('thing', { id: 3 });
				await loaded.fetch();
				assert.equal(loaded.get('name'), 'Third');
			});

			it('rolls an optimistic change back when the server refuses it', async () => {
				const things = Alloy.Collections.things;
				await things.fetch();
				const first = things.get(1);
				const handle = first.save({ name: 'Refused' }, { optimistic: true, query: { fail: 409 } });
				assert.equal(first.get('name'), 'Refused');
				assert.equal((await rejection(handle)).status, 409);
				assert.equal(first.get('name'), 'First');
			});

			it('a refresh that changes nothing touches nothing', async () => {
				const things = Alloy.Collections.things;
				await things.fetch();
				const models = things.models.slice();
				let changes = 0;
				things.on('all', (name) => {
					if (name !== 'request' && name !== 'sync') {
						changes++;
					}
				});
				const result = await things.fetch();
				assert.equal(result.unchanged, true);
				assert.deepEqual(things.models, models);
				assert.equal(changes, 0);
			});

			it('pages a collection to the end and refreshes back to the first page', async () => {
				const items = Alloy.Collections.pagedItems;
				await items.fetch();
				assert.equal(items.length, 10);
				assert.equal(items.paging.total, 45);
				while (items.hasMore()) {
					await items.fetchNext();
				}
				assert.equal(items.length, 45);
				await items.refresh();
				assert.equal(items.length, 10);
			});
		});
	});
});
