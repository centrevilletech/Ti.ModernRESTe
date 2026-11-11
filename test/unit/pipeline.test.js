'use strict';

/* De-duplication, interceptors, status hooks, sessions, the logger. */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rejection, wait, until } = require('../helpers/setup');

let ti;
afterEach(() => ti && ti.uninstall());

const METHODS = [
	{ name: 'list', get: 'things' }, { name: 'get', get: 'things/<id>' }, { name: 'post', post: 'things' },
	{ name: 'login', post: 'login', session: false, statusHooks: false }
];

function make(config) {
	const made = setup(Object.assign({ methods: METHODS }, config));
	ti = made.ti;
	return made;
}

describe('in-flight de-duplication', () => {
	it('shares one request between identical GETs when switched on', async () => {
		const { api } = make({ dedupe: true });
		ti.respond(() => null);
		const a = api.list();
		const b = api.list();
		const c = api.get({ id: 1 });
		assert.equal(ti.requests.length, 2);
		ti.requests[0].respond({ status: 200, body: { n: 1 } });
		ti.requests[1].respond({ status: 200, body: { n: 2 } });
		const [first, second, third] = await Promise.all([a, b, c]);
		assert.deepEqual(first, { n: 1 });
		assert.equal(second, first); // the same parsed body
		assert.deepEqual(third, { n: 2 });
	});

	it('is off by default, and can be set per method or per call', async () => {
		const { api } = make({ methods: [{ name: 'list', get: 'things' }, { name: 'shared', get: 'shared', dedupe: true }] });
		ti.respond(() => ({ status: 200, body: {} }));
		await Promise.all([api.list(), api.list()]);
		assert.equal(ti.requests.length, 2);
		await Promise.all([api.shared(), api.shared(), api.shared({}, { dedupe: false })]);
		assert.equal(ti.requests.length, 4);
		await Promise.all([api.list({}, { dedupe: true }), api.list({}, { dedupe: true })]);
		assert.equal(ti.requests.length, 5);
	});

	it('does not share requests with different headers, queries or methods', async () => {
		const { api } = make({ dedupe: true });
		ti.respond(() => ({ status: 200, body: {} }));
		await Promise.all([
			api.list({}, { headers: { Authorization: 'a' } }), api.list({}, { headers: { Authorization: 'b' } }),
			api.list({ query: { page: 1 } }), api.list({ query: { page: 2 } }),
			api.post({ body: {} }), api.post({ body: {} })
		]);
		assert.equal(ti.requests.length, 6);
	});

	it('shares failures too, and sends again once the first is over', async () => {
		const { api } = make({ dedupe: true });
		ti.respond(() => ({ status: 500 }));
		const [a, b] = await Promise.all([rejection(api.list()), rejection(api.list())]);
		assert.equal(a.status, 500);
		assert.equal(b.status, 500);
		assert.equal(ti.requests.length, 1);
		await rejection(api.list());
		assert.equal(ti.requests.length, 2);
	});

	it('aborting one caller leaves the shared request running for the others', async () => {
		const { api } = make({ dedupe: true });
		ti.respond(() => null);
		const a = api.list();
		const b = api.list();
		const c = api.list();
		a.abort(); // the caller that sent it
		c.abort();
		assert.equal(ti.requests[0].aborted, false);
		ti.requests[0].respond({ status: 200, body: { ok: true } });
		assert.deepEqual(await b, { ok: true });
		assert.equal((await rejection(a)).kind, 'cancelled');
		assert.equal((await rejection(c)).kind, 'cancelled');
	});

	it('aborting every caller aborts the request', async () => {
		const { api } = make({ dedupe: true });
		ti.respond(() => null);
		const a = api.list();
		const b = api.list();
		a.abort();
		b.abort();
		assert.equal(ti.requests[0].aborted, true);
		await rejection(a);
		await rejection(b);
		ti.respond(() => ({ status: 200, body: {} }));
		await api.list();
		assert.equal(ti.requests.length, 2);
	});

	it('retries once for all callers', async () => {
		const { api } = make({ dedupe: true, retry: { retries: 1, baseDelay: 1, jitter: 0 } });
		let n = 0;
		ti.respond(() => (n++ === 0 ? { status: 503 } : { status: 200, body: { n } }));
		const [a, b] = await Promise.all([api.list(), api.list()]);
		assert.deepEqual(a, { n: 2 });
		assert.equal(b, a);
		assert.equal(ti.requests.length, 2);
	});
});

describe('interceptors', () => {
	it('request interceptors can change the request, in order: global, method, call', async () => {
		const order = [];
		const { api } = make({
			interceptors: {
				request: (request) => {
					order.push('global');
					request.headers['X-Trace'] = 'g';
				}
			},
			methods: [{
				name: 'post', post: 'things', interceptors: {
					request: [(request) => {
						order.push('method');
						request.url += '?m=1';
					}]
				}
			}]
		});
		ti.respond(() => ({ status: 200, body: {} }));
		await api.post({ body: { a: 1 } }, {
			interceptors: {
				request: [(request) => {
					order.push('call');
					request.body = Object.assign({ stamped: true }, request.body);
					request.method = 'PUT';
				}]
			}
		});
		assert.deepEqual(order, ['global', 'method', 'call']);
		assert.equal(ti.last.method, 'PUT');
		assert.equal(ti.last.url, 'https://api.test/v1/things?m=1');
		assert.equal(ti.last.headers['X-Trace'], 'g');
		assert.deepEqual(ti.last.json, { stamped: true, a: 1 });
	});

	it('request interceptors may be asynchronous and see what is being sent', async () => {
		const seen = [];
		const { api } = make();
		api.use({
			request: request => wait(5).then(() => {
				seen.push([request.name, request.method, request.attempt, request.params.id]);
				request.headers.Authorization = 'Bearer late';
			})
		});
		ti.respond(() => ({ status: 200, body: {} }));
		await api.get({ id: 7 });
		assert.deepEqual(seen, [['get', 'GET', 1, 7]]);
		assert.equal(ti.last.headers.Authorization, 'Bearer late');
	});

	it('a request interceptor that throws rejects the call without sending', async () => {
		const { api } = make({ interceptors: { request: () => { throw new Error('not signed in'); } } });
		const error = await rejection(api.list());
		assert.match(error.message, /not signed in/);
		assert.equal(ti.requests.length, 0);
	});

	it('response interceptors can change or replace the response', async () => {
		const { api } = make({
			interceptors: {
				response: [
					(response) => {
						response.data = { wrapped: response.data };
					},
					(response, request) => Promise.resolve(Object.assign(response, { data: Object.assign({ by: request.name }, response.data) }))
				]
			}
		});
		ti.respond(() => ({ status: 200, body: { a: 1 } }));
		assert.deepEqual(await api.list(), { by: 'list', wrapped: { a: 1 } });
	});

	it('a response interceptor that throws turns success into a failure', async () => {
		const { api } = make({ interceptors: { response: (response) => { throw new Error('bad shape: ' + response.status); } } });
		ti.respond(() => ({ status: 200, body: {} }));
		assert.match((await rejection(api.list())).message, /bad shape: 200/);
	});

	it('error interceptors can replace the error or recover the request', async () => {
		const { api } = make({
			interceptors: {
				error: [
					error => (error.status === 404 ? { resolve: { missing: true } } : undefined),
					error => (error.status === 500 ? new Error('server down') : undefined),
					(error) => {
						if (error.status === 418) {
							throw new Error('teapot');
						}
					}
				]
			}
		});
		ti.respond(() => ({ status: 404 }));
		assert.deepEqual(await api.list(), { missing: true });
		ti.respond(() => ({ status: 500 }));
		assert.equal((await rejection(api.list())).message, 'server down');
		ti.respond(() => ({ status: 418 }));
		assert.equal((await rejection(api.list())).message, 'teapot');
		ti.respond(() => ({ status: 400 }));
		assert.equal((await rejection(api.list())).status, 400);
	});

	it('use() returns a function that removes what it added', async () => {
		const { api } = make();
		const remove = api.use({ request: request => (request.headers['X-Temp'] = '1') });
		ti.respond(() => ({ status: 200, body: {} }));
		await api.list();
		remove();
		await api.list();
		assert.deepEqual(ti.requests.map(request => request.headers['X-Temp']), ['1', undefined]);
	});
});

describe('status hooks', () => {
	it('fire once for a burst of concurrent requests', async () => {
		const fired = [];
		const { api } = make({ onStatus: { 401: (error, request) => fired.push([error.status, request.name]) } });
		ti.respond(() => null);
		const calls = [api.list(), api.get({ id: 1 }), api.get({ id: 2 }), api.post({ body: {} })];
		ti.requests.forEach(request => request.respond({ status: 401, body: { code: 'UNAUTHENTICATED' } }));
		const errors = await Promise.all(calls.map(rejection));
		assert.deepEqual(errors.map(error => error.status), [401, 401, 401, 401]);
		assert.deepEqual(fired, [[401, 'list']]);
	});

	it('fire again for a request sent after the hook fired', async () => {
		let fired = 0;
		const { api } = make({ onStatus: { 426: () => fired++ } });
		ti.respond(() => ({ status: 426 }));
		await rejection(api.list());
		await rejection(api.list());
		assert.equal(fired, 2);
	});

	it('keep separate books per status and ignore endpoints that opt out', async () => {
		const fired = [];
		const { api } = make({ onStatus: { 401: () => fired.push(401), 429: error => fired.push([429, error.retryAfter]) } });
		ti.respond(request => (request.url.indexOf('login') !== -1 ? { status: 401 } : { status: 429, headers: { 'Retry-After': '2' } }));
		await rejection(api.login({ body: {} })); // statusHooks: false: a wrong password is not "session ended"
		await rejection(api.list());
		assert.deepEqual(fired, [[429, 2000]]);
	});

	it('a hook that answers "retry" sends each waiting request once more', async () => {
		let token = 'old';
		let refreshes = 0;
		const { api } = make({
			requestHeaders: { Authorization: () => 'Bearer ' + token },
			onStatus: {
				401: () => wait(5).then(() => {
					refreshes++;
					token = 'new';
					return 'retry';
				})
			}
		});
		ti.respond(request => (request.headers.Authorization === 'Bearer new' ? { status: 200, body: { url: request.url } } : { status: 401 }));
		const results = await Promise.all([api.list(), api.get({ id: 1 }), api.get({ id: 2 })]);
		assert.equal(refreshes, 1);
		assert.deepEqual(results.map(result => result.url), ['https://api.test/v1/things', 'https://api.test/v1/things/1', 'https://api.test/v1/things/2']);
		assert.equal(ti.requests.length, 6);
	});

	it('requests that fail while the hook is still working join it', async () => {
		let token = 'old';
		let refreshes = 0;
		const { api } = make({
			requestHeaders: { Authorization: () => 'Bearer ' + token },
			onStatus: {
				401: () => wait(20).then(() => {
					refreshes++;
					token = 'new';
					return { retry: true };
				})
			}
		});
		ti.respond(request => (request.headers.Authorization === 'Bearer new' ? { status: 200, body: {} } : { status: 401 }));
		const first = api.list();
		await wait(8); // the hook is running; this one is sent with the old token
		const second = api.get({ id: 1 });
		await Promise.all([first, second]);
		assert.equal(refreshes, 1);
	});

	it('a request is retried by a hook only once', async () => {
		const seen = [];
		const { api } = make({
			onStatus: {
				401: (error, request) => {
					seen.push(request.retried);
					return 'retry';
				}
			}
		});
		ti.respond(() => ({ status: 401 }));
		assert.equal((await rejection(api.list())).status, 401);
		assert.equal(ti.requests.length, 2);
		assert.deepEqual(seen, [false, true]);
	});

	it('a hook that throws does not break the request', async () => {
		const { api } = make({ logger: () => {}, onStatus: { 500: () => { throw new Error('hook bug'); } } });
		ti.respond(() => ({ status: 500 }));
		assert.equal((await rejection(api.list())).status, 500);
	});
});

describe('sessions', () => {
	it('drop responses that arrive after the session was reset', async () => {
		const { api } = make();
		ti.respond(() => null);
		const loaded = [];
		const handle = api.list(body => loaded.push(body), error => loaded.push(error));
		const before = api.session.generation;
		api.session.reset({ abort: false });
		assert.equal(api.session.generation, before + 1);
		ti.requests[0].respond({ status: 200, body: { secret: 'of the previous user' } });
		const error = await rejection(handle);
		assert.equal(error.kind, 'stale');
		assert.equal(error.isStale, true);
		assert.equal(error.isCancelled, true);
		assert.deepEqual(loaded, []); // no callback, no global handler
	});

	it('abort in-flight requests by default, as stale', async () => {
		const globalErrors = [];
		const { api } = make({ onError: error => globalErrors.push(error) });
		ti.respond(() => null);
		const handle = api.list();
		api.session.reset();
		assert.equal(ti.requests[0].aborted, true);
		assert.equal((await rejection(handle)).kind, 'stale');
		assert.deepEqual(globalErrors, []);
	});

	it('leave requests of endpoints that are not tied to a session alone', async () => {
		const { api } = make();
		ti.respond(() => null);
		const handle = api.login({ body: {} });
		api.session.reset();
		ti.requests[0].respond({ status: 200, body: { token: 't' } });
		assert.deepEqual(await handle, { token: 't' });
	});

	it('do not fire a 401 hook for a stale response, and re-arm hooks', async () => {
		let fired = 0;
		const { api } = make({ onStatus: { 401: () => fired++ } });
		ti.respond(() => null);
		const stale = api.list();
		api.session.reset({ abort: false });
		ti.requests[0].respond({ status: 401 });
		await rejection(stale);
		assert.equal(fired, 0);
		ti.respond(() => ({ status: 401 }));
		await rejection(api.list());
		assert.equal(fired, 1);
	});

	it('clear the cache and idempotency actions, unless told not to', async () => {
		const { api } = make({ methods: [{ name: 'cached', get: 'cached', cache: { ttl: 10000 } }, { name: 'order', post: 'o', idempotent: true }] });
		ti.respond(() => ({ status: 200, body: {} }));
		await api.cached();
		const key = api.idempotency.key('checkout', {});
		api.session.reset({ clearCache: false });
		assert.equal(api.cache.size, 1);
		assert.notEqual(api.idempotency.key('checkout', {}), key);
		api.session.reset();
		assert.equal(api.cache.size, 0);
	});
});

describe('debug logging', () => {
	function logged(config) {
		const lines = [];
		const made = make(Object.assign({ logger: (level, message, details) => lines.push(message + (details ? ' ' + JSON.stringify(details) : '')) }, config));
		return { api: made.api, lines, text: () => lines.join('\n') };
	}

	it('is silent unless debug is on', async () => {
		const { api, lines } = logged({});
		ti.respond(() => ({ status: 200, body: {} }));
		await api.list();
		assert.deepEqual(lines, []);
	});

	it('logs method, URL, status and time', async () => {
		const { api, text } = logged({ debug: true });
		ti.respond(() => ({ status: 200, body: {} }));
		await api.get({ id: 3 });
		assert.match(text(), /GET https:\/\/api\.test\/v1\/things\/3/);
		assert.match(text(), /200 in \d+ms/);
	});

	it('never prints credentials: headers, body fields and query values are redacted', async () => {
		const { api, text } = logged({
			debug: 'verbose',
			requestHeaders: { Authorization: 'Bearer SECRET-TOKEN', 'X-Api-Key': 'SECRET-KEY', 'X-Tenant': 'SECRET-TENANT', Accept: 'application/json' },
			redact: { headers: ['X-Tenant'], keys: ['pin'] }
		});
		ti.respond(() => ({ status: 200, body: {} }));
		await api.post({ body: { email: 'a@b.c', password: 'SECRET-PASSWORD', nested: { token: 'SECRET-NESTED', pin: 'SECRET-PIN' } }, query: { access_token: 'SECRET-QUERY', page: 2 } });
		const output = text();
		assert.doesNotMatch(output, /SECRET/);
		assert.match(output, /\[redacted\]/);
		assert.match(output, /a@b\.c/);
		assert.match(output, /application\/json/);
		assert.match(output, /page=2/);
	});

	it('prints through console as ::RESTE:: lines without a custom logger', async () => {
		const made = make({ debug: true });
		const original = console.log;
		const lines = [];
		console.log = line => lines.push(line);
		try {
			ti.respond(() => ({ status: 200, body: {} }));
			await made.api.list();
		} finally {
			console.log = original;
		}
		assert.ok(lines.length >= 2);
		lines.forEach(line => assert.match(line, /^::RESTE::/));
	});

	it('warns when certificate validation is switched off', () => {
		const { text } = logged({ debug: true, validatesSecureCertificate: false });
		assert.match(text(), /NOT verified/);
	});

	it('logs failures and retries', async () => {
		const { api, text } = logged({ debug: true, retry: { retries: 1, baseDelay: 1, jitter: 0 } });
		ti.respond(() => ({ status: 503 }));
		await rejection(api.list());
		assert.match(text(), /retrying list in \d+ms after 503/);
		assert.match(text(), /failed: 503/);
		await until(() => true);
	});
});
