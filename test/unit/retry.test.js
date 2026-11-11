'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rejection } = require('../helpers/setup');
const { normalizeRetry, retryDelay, shouldRetry } = require('../../src/retry');

let ti;
afterEach(() => ti && ti.uninstall());

const FAST = { retries: 2, baseDelay: 1, maxDelay: 4, jitter: 0 };

function make(config) {
	const made = setup(Object.assign({
		retry: FAST,
		methods: [
			{ name: 'get', get: 'thing' }, { name: 'post', post: 'thing' }, { name: 'put', put: 'thing' },
			{ name: 'safePut', put: 'safe', retry: true }, { name: 'never', get: 'never', retry: false },
			{ name: 'keyed', post: 'keyed', idempotent: true }
		]
	}, config));
	ti = made.ti;
	return made;
}

/** Fails `failures` times with `answer`, then succeeds. */
function flaky(failures, answer) {
	let seen = 0;
	ti.respond(() => (seen++ < failures ? answer : { status: 200, body: { attempt: seen } }));
}

describe('retries', () => {
	it('are off unless configured', async () => {
		const { api } = make({ retry: undefined });
		flaky(1, { status: 503 });
		assert.equal((await rejection(api.get())).status, 503);
		assert.equal(ti.requests.length, 1);
	});

	it('repeat a GET after 502, 503, 504, a dropped connection or a timeout', async () => {
		const { api } = make();
		for (const answer of [{ status: 502 }, { status: 503 }, { status: 504 }, { error: 'reset' }, { error: 'timeout' }]) {
			ti.reset();
			flaky(2, answer);
			const response = await api.get({}, { fullResponse: true });
			assert.equal(response.data.attempt, 3);
			assert.equal(response.attempts, 3);
		}
	});

	it('give up after the configured number and report the attempts', async () => {
		const { api } = make();
		flaky(10, { status: 503 });
		const error = await rejection(api.get());
		assert.equal(error.status, 503);
		assert.equal(error.attempts, 3);
		assert.equal(ti.requests.length, 3);
	});

	it('do not repeat 4xx or 500', async () => {
		const { api } = make();
		for (const status of [400, 401, 404, 422, 429, 500]) {
			ti.reset();
			flaky(1, { status });
			assert.equal((await rejection(api.get())).status, status);
			assert.equal(ti.requests.length, 1);
		}
	});

	it('never repeat a POST or PUT on their own', async () => {
		const { api } = make();
		flaky(1, { error: 'timeout' });
		assert.equal((await rejection(api.post({ body: {} }))).kind, 'timeout');
		flaky(1, { error: 'timeout' });
		assert.equal((await rejection(api.put({ body: {} }))).kind, 'timeout');
		assert.equal(ti.requests.length, 2);
	});

	it('repeat a non-idempotent method when the endpoint opts in', async () => {
		const { api } = make();
		flaky(1, { status: 503 });
		assert.deepEqual(await api.safePut({ body: {} }), { attempt: 2 });
	});

	it('repeat a request that carries an idempotency key, with the same key', async () => {
		const { api } = make();
		flaky(2, { error: 'reset' });
		const handle = api.keyed({ body: { a: 1 } });
		await handle;
		const keys = ti.requests.map(request => request.headers['Idempotency-Key']);
		assert.equal(keys.length, 3);
		assert.ok(keys[0]);
		assert.deepEqual(keys, [keys[0], keys[0], keys[0]]);
		assert.equal(handle.idempotencyKey, keys[0]);
	});

	it('can be switched off for one endpoint or one call, and on for one call', async () => {
		const { api } = make();
		flaky(1, { status: 503 });
		assert.equal((await rejection(api.never())).status, 503);
		ti.reset();
		flaky(1, { status: 503 });
		assert.equal((await rejection(api.get({}, { retry: false }))).status, 503);
		ti.reset();
		flaky(1, { status: 503 });
		assert.deepEqual(await api.post({ body: {} }, { retry: { retries: 1, baseDelay: 1, jitter: 0 } }), { attempt: 2 });
	});

	it('wait as long as Retry-After asks, up to the cap', async () => {
		const { api } = make({ retry: { retries: 1, baseDelay: 1, jitter: 0, statuses: [429, 503], maxRetryAfter: 60 } });
		flaky(1, { status: 429, headers: { 'Retry-After': '0.04' } });
		let started = Date.now();
		await api.get();
		assert.ok(Date.now() - started >= 35, 'waited for Retry-After');
		ti.reset();
		flaky(1, { status: 503, headers: { 'Retry-After': '30' } });
		started = Date.now();
		await api.get();
		assert.ok(Date.now() - started < 500, 'capped by maxRetryAfter');
	});

	it('let shouldRetry overrule the defaults, but not the safety rule', async () => {
		const { api } = make({ retry: Object.assign({}, FAST, { shouldRetry: error => error.status === 500 }) });
		flaky(1, { status: 500 });
		assert.deepEqual(await api.get(), { attempt: 2 });
		ti.reset();
		flaky(1, { status: 500 });
		assert.equal((await rejection(api.post({ body: {} }))).status, 500);
		assert.equal(ti.requests.length, 1);
	});

	it('run request interceptors and header functions again for every attempt', async () => {
		let token = 0;
		const { api } = make({ requestHeaders: { Authorization: () => 'Bearer ' + (++token) } });
		flaky(2, { status: 503 });
		await api.get();
		assert.deepEqual(ti.requests.map(request => request.headers.Authorization), ['Bearer 1', 'Bearer 2', 'Bearer 3']);
	});
});

describe('retry policy', () => {
	it('backs off exponentially, capped, with jitter in range', () => {
		const policy = normalizeRetry({ baseDelay: 100, maxDelay: 1000, jitter: 0 });
		assert.deepEqual([1, 2, 3, 4, 5].map(attempt => retryDelay(policy, attempt)), [100, 200, 400, 800, 1000]);
		const jittered = normalizeRetry({ baseDelay: 100, jitter: 0.25 });
		assert.equal(retryDelay(jittered, 1, null, () => 0), 75);
		assert.equal(retryDelay(jittered, 1, null, () => 1), 125);
	});

	it('normalises true, numbers, objects and false', () => {
		assert.equal(normalizeRetry(false), null);
		assert.equal(normalizeRetry(undefined), null);
		assert.equal(normalizeRetry(true).retries, 2);
		assert.equal(normalizeRetry(5).retries, 5);
		assert.equal(normalizeRetry({ retries: 1 }, normalizeRetry({ baseDelay: 9 })).baseDelay, 9);
	});

	it('never retries cancelled, stale or parameter errors', () => {
		const policy = normalizeRetry({ shouldRetry: () => true });
		['cancelled', 'stale', 'params', 'config'].forEach((kind) => {
			assert.equal(shouldRetry(policy, { kind }, 1, { method: 'GET' }), false);
		});
	});
});
