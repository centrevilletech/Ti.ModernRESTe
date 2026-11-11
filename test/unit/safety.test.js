'use strict';

/* The promises the README makes about what can go wrong: sessions, retries, calls that never throw. */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rejection, wait } = require('../helpers/setup');

let ti;
afterEach(() => ti && ti.uninstall());

function make(config) {
	const made = setup(config);
	ti = made.ti;
	return made;
}

describe('a session reset and requests that are waiting to be sent again', () => {
	it('a retry that was waiting is not sent for the next user', async () => {
		let token = 'USER-A';
		let sent = 0;
		let asked = 0;
		const { api } = make({
			retry: { retries: 2, baseDelay: 30, jitter: 0 },
			requestHeaders: {
				Authorization: () => {
					asked++;
					return 'Bearer ' + token;
				}
			},
			methods: [{ name: 'pay', post: 'payments', idempotent: true }]
		});
		ti.respond(() => (++sent === 1 ? { error: 'connection dropped' } : { status: 201, body: { ok: true } }));
		const handle = api.pay({ body: { amount: 100 } });
		await wait(5);
		api.session.reset({ abort: false }); // the user signs out; the next one signs in
		token = 'USER-B';
		const error = await rejection(handle);
		await wait(80);
		assert.equal(error.kind, 'stale');
		assert.deepEqual(ti.requests.map(request => request.headers.Authorization), ['Bearer USER-A']);
		assert.equal(asked, 1, 'the next user\'s token was not even read for the old request');
	});

	it('a request held by an interceptor is not sent after the reset', async () => {
		const { api } = make({ interceptors: { request: () => wait(20) }, methods: [{ name: 'get', get: 'things' }] });
		ti.respond(() => ({ status: 200, body: {} }));
		const handle = api.get();
		api.session.reset({ abort: false });
		assert.equal((await rejection(handle)).kind, 'stale');
		await wait(30);
		assert.equal(ti.requests.length, 0);
	});

	it('a status hook that answers "retry" after the session changed re-sends nothing', async () => {
		let release;
		const { api } = make({
			onStatus: { 401: () => new Promise((resolve) => { release = () => resolve('retry'); }) },
			methods: [{ name: 'get', get: 'things' }]
		});
		ti.respond(() => ({ status: 401 }));
		const handle = api.get();
		await wait(5);
		api.session.reset({ abort: false });
		release();
		const error = await rejection(handle);
		await wait(10);
		assert.equal(ti.requests.length, 1);
		assert.equal(error.kind, 'stale');
	});

	it('identical GETs of different sessions are not joined', async () => {
		const { api } = make({ dedupe: true, methods: [{ name: 'me', get: 'me' }] });
		ti.respond(() => null);
		const before = api.me();
		api.session.reset({ abort: false });
		const after = api.me();
		assert.equal(ti.requests.length, 2);
		ti.requests[0].respond({ status: 200, body: { user: 'A' } });
		ti.requests[1].respond({ status: 200, body: { user: 'B' } });
		assert.equal((await rejection(before)).kind, 'stale');
		assert.deepEqual(await after, { user: 'B' });
	});
});

describe('only requests that are safe to repeat are sent again', () => {
	const METHODS = [
		{ name: 'createOrder', post: 'orders' },
		{ name: 'keyed', post: 'keyed', idempotent: true },
		{ name: 'safePost', post: 'safe', retry: true },
		{ name: 'list', get: 'list' }
	];

	it('a per-call retry does not make a POST repeatable', async () => {
		const { api } = make({ retry: true, methods: METHODS });
		ti.respond(() => ({ error: 'connection dropped' }));
		const error = await rejection(api.createOrder({ body: { sku: 1 } }, { retry: { retries: 3, baseDelay: 1, jitter: 0 } }));
		assert.equal(error.kind, 'network');
		assert.equal(ti.requests.length, 1);
		assert.equal(error.attempts, 1);
	});

	it('a per-call retry changes how often a repeatable request is sent, and can switch it off', async () => {
		const { api } = make({ methods: METHODS });
		ti.respond(() => ({ status: 503 }));
		await rejection(api.list({}, { retry: { retries: 3, baseDelay: 1, jitter: 0 } }));
		assert.equal(ti.requests.length, 4);
		ti.reset();
		ti.respond(() => ({ status: 503 }));
		await rejection(api.keyed({ body: {} }, { retry: { retries: 1, baseDelay: 1, jitter: 0 } }));
		assert.equal(ti.requests.length, 2);
		ti.reset();
		ti.respond(() => ({ status: 503 }));
		await rejection(api.safePost({ body: {} }, { retry: false }));
		assert.equal(ti.requests.length, 1);
	});

	it('a status hook\'s "retry" re-sends a POST only after a 401', async () => {
		const { api } = make({ onStatus: { 503: () => 'retry', 401: () => 'retry' }, methods: METHODS });
		ti.respond(() => ({ status: 503 }));
		assert.equal((await rejection(api.createOrder({ body: {} }))).status, 503);
		assert.equal(ti.requests.length, 1); // the server may have done the work: not ours to repeat
		ti.reset();
		let sent = 0;
		ti.respond(() => (++sent === 1 ? { status: 401 } : { status: 201, body: { ok: true } }));
		assert.deepEqual(await api.createOrder({ body: {} }), { ok: true }); // refused before any work: safe
		assert.equal(ti.requests.length, 2);
	});

	it('a status hook\'s "retry" re-sends repeatable requests whatever the status', async () => {
		const { api } = make({ onStatus: { 503: () => 'retry' }, methods: METHODS });
		for (const call of [() => api.list(), () => api.keyed({ body: {} }), () => api.safePost({ body: {} })]) {
			ti.reset();
			let sent = 0;
			ti.respond(() => (++sent === 1 ? { status: 503 } : { status: 200, body: { ok: true } }));
			assert.deepEqual(await call(), { ok: true });
			assert.equal(ti.requests.length, 2);
		}
	});

	it('the statuses after which a hook may re-send anything can be configured', async () => {
		const { api } = make({ authStatuses: [401, 419], onStatus: { 419: () => 'retry' }, methods: METHODS });
		let sent = 0;
		ti.respond(() => (++sent === 1 ? { status: 419 } : { status: 201, body: {} }));
		await api.createOrder({ body: {} });
		assert.equal(ti.requests.length, 2);
	});
});

describe('a call never throws', () => {
	const failing = () => {
		throw new Error('no token');
	};

	it('a header function that throws rejects the call', async () => {
		const { api } = make({ requestHeaders: { Authorization: failing }, methods: [{ name: 'get', get: 'things' }] });
		let handle;
		assert.doesNotThrow(() => {
			handle = api.get();
		});
		const error = await rejection(handle);
		assert.match(error.message, /no token/);
		assert.equal(ti.requests.length, 0);
	});

	it('a header function that throws on a retry settles the call', async () => {
		let calls = 0;
		const { api } = make({
			retry: { retries: 2, baseDelay: 5, jitter: 0 },
			requestHeaders: {
				Authorization: () => {
					if (++calls > 1) {
						throw new Error('token gone');
					}
					return 'Bearer x';
				}
			},
			methods: [{ name: 'get', get: 'things' }]
		});
		ti.respond(() => ({ status: 503 }));
		const error = await Promise.race([rejection(api.get()), wait(300).then(() => ({ message: 'never settled' }))]);
		assert.match(error.message, /token gone/);
		assert.equal(ti.requests.length, 1);
	});

	it('it settles every caller of a shared request', async () => {
		let calls = 0;
		const { api } = make({
			dedupe: true,
			retry: { retries: 2, baseDelay: 5, jitter: 0 },
			requestHeaders: {
				'X-Seq': () => {
					if (++calls > 2) {
						throw new Error('header failed on the retry');
					}
					return 'same';
				}
			},
			methods: [{ name: 'get', get: 'things' }]
		});
		ti.respond(() => ({ status: 503 }));
		const first = api.get();
		const second = api.get();
		const errors = await Promise.race([Promise.all([rejection(first), rejection(second)]), wait(300).then(() => 'never settled')]);
		assert.notEqual(errors, 'never settled');
		errors.forEach(error => assert.match(error.message, /header failed/));
	});

	it('beforeSend and beforePost that throw reject the call', async () => {
		for (const hook of ['beforeSend', 'beforePost']) {
			const config = { methods: [{ name: 'post', post: 'things' }] };
			config[hook] = () => {
				throw new Error('a bug in ' + hook);
			};
			const { api } = make(config);
			const errors = [];
			let handle;
			assert.doesNotThrow(() => {
				handle = api.post({ body: {} }, () => {}, error => errors.push(error));
			});
			assert.match((await rejection(handle)).message, new RegExp('a bug in ' + hook));
			assert.equal(errors.length, 1);
			assert.equal(ti.requests.length, 0);
			ti.uninstall();
		}
	});

	it('a cache key function that throws rejects the call', async () => {
		const { api } = make({ methods: [{ name: 'get', get: 'things', cache: { ttl: 1000, key: failing } }] });
		let handle;
		assert.doesNotThrow(() => {
			handle = api.get();
		});
		assert.match((await rejection(handle)).message, /no token/);
	});

	it('an onLoad hook that throws fails the call instead of leaving it open', async () => {
		const { api } = make({ onLoad: failing, methods: [{ name: 'get', get: 'things' }] });
		ti.respond(() => ({ status: 200, body: {} }));
		const error = await Promise.race([rejection(api.get()), wait(200).then(() => ({ message: 'never settled' }))]);
		assert.match(error.message, /no token/);
	});

	it('a handle that failed before anything was sent still answers abort()', async () => {
		const { api } = make({ methods: [{ name: 'get', get: 'things/<id>' }] });
		const missing = api.get({});
		const unknown = api.request('nope');
		assert.equal(unknown.abort(), false);
		await rejection(missing);
		assert.equal(missing.abort(), false);
		await rejection(unknown);
	});
});
