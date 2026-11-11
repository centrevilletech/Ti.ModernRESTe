'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rejection } = require('../helpers/setup');

let ti;
afterEach(() => ti && ti.uninstall());

function make(config) {
	const made = setup(Object.assign({
		methods: [{ name: 'order', post: 'orders', idempotent: true }, { name: 'plain', post: 'plain' }, { name: 'patch', patch: 'p' }, { name: 'optOut', post: 'o', idempotent: false }]
	}, config));
	ti = made.ti;
	ti.respond(() => ({ status: 201, body: { ok: true } }));
	return made;
}

const keyOf = request => request.headers['Idempotency-Key'];

describe('idempotency keys', () => {
	it('are generated for idempotent endpoints and exposed on the handle, the response and the error', async () => {
		const { api } = make();
		const handle = api.order({ body: { item: 1 } }, { fullResponse: true });
		assert.ok(handle.idempotencyKey);
		const response = await handle;
		assert.equal(keyOf(ti.last), handle.idempotencyKey);
		assert.equal(response.idempotencyKey, handle.idempotencyKey);
		ti.respond(() => ({ status: 500 }));
		const failing = api.order({ body: { item: 1 } });
		assert.equal((await rejection(failing)).idempotencyKey, failing.idempotencyKey);
	});

	it('differ between calls and are absent elsewhere', async () => {
		const { api } = make();
		await api.order({ body: { item: 1 } });
		await api.order({ body: { item: 1 } });
		await api.plain({ body: {} });
		assert.notEqual(keyOf(ti.requests[0]), keyOf(ti.requests[1]));
		assert.equal(keyOf(ti.requests[2]), undefined);
	});

	it('use the key the caller passes', async () => {
		const { api } = make();
		await api.plain({ body: {} }, { idempotencyKey: 'mine' });
		assert.equal(keyOf(ti.last), 'mine');
	});

	it('can be switched on per HTTP method, with a custom header and generator', async () => {
		let n = 0;
		const { api } = make({ idempotency: { header: 'X-Request-Key', methods: ['post', 'PATCH'], generate: () => 'k' + (++n) } });
		await api.plain({ body: {} });
		await api.patch({ body: {} });
		await api.optOut({ body: {} });
		assert.deepEqual(ti.requests.map(request => request.headers['X-Request-Key']), ['k1', 'k2', undefined]);
	});

	it('an action keeps its key while it is repeated unchanged and gets a new one once it succeeded', async () => {
		const { api } = make();
		ti.respond(() => ({ error: 'timeout' }));
		await rejection(api.order({ body: { item: 1 } }, { action: 'checkout' }));
		await rejection(api.order({ body: { item: 1 } }, { action: 'checkout' }));
		ti.respond(() => ({ status: 201, body: {} }));
		await api.order({ body: { item: 1 } }, { action: 'checkout' });
		await api.order({ body: { item: 1 } }, { action: 'checkout' });
		const keys = ti.requests.map(keyOf);
		assert.equal(keys[0], keys[1]);
		assert.equal(keys[1], keys[2]);
		assert.notEqual(keys[2], keys[3]);
	});

	it('an action gets a new key when its payload changes or the server gave a definite refusal', async () => {
		const { api } = make();
		ti.respond(() => ({ error: 'reset' }));
		await rejection(api.order({ body: { item: 1 } }, { action: 'checkout' }));
		await rejection(api.order({ body: { item: 2 } }, { action: 'checkout' }));
		ti.respond(() => ({ status: 422 }));
		await rejection(api.order({ body: { item: 2 } }, { action: 'checkout' }));
		await rejection(api.order({ body: { item: 2 } }, { action: 'checkout' }));
		const keys = ti.requests.map(keyOf);
		assert.notEqual(keys[0], keys[1]); // payload changed
		assert.equal(keys[1], keys[2]); // repeated after a network failure
		assert.notEqual(keys[2], keys[3]); // 422 was an answer
	});

	it('an action keeps its key through 409 and 5xx', async () => {
		const { api } = make();
		ti.respond(() => ({ status: 409 }));
		await rejection(api.order({ body: {} }, { action: 'a' }));
		ti.respond(() => ({ status: 503 }));
		await rejection(api.order({ body: {} }, { action: 'a' }));
		await rejection(api.order({ body: {} }, { action: 'a' }));
		const keys = ti.requests.map(keyOf);
		assert.deepEqual(keys, [keys[0], keys[0], keys[0]]);
	});

	it('api.idempotency manages keys by hand', () => {
		const { api } = make();
		const first = api.idempotency.key('pay', { amount: 5 });
		assert.equal(api.idempotency.key('pay', { amount: 5 }), first);
		assert.notEqual(api.idempotency.key('pay', { amount: 6 }), first);
		api.idempotency.done('pay');
		assert.notEqual(api.idempotency.key('pay', { amount: 6 }), first);
		assert.notEqual(api.idempotency.generate(), api.idempotency.generate());
	});
});
