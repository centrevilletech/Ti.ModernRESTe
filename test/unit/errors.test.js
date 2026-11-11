'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rejection } = require('../helpers/setup');
const { parseRetryAfter, classifyFailure } = require('../../src/errors');

let ti;
afterEach(() => ti && ti.uninstall());

function make(config) {
	const made = setup(Object.assign({ methods: [{ name: 'get', get: 'thing' }, { name: 'post', post: 'thing' }] }, config));
	ti = made.ti;
	return made;
}

describe('ResteError', () => {
	it('carries status, parsed body, headers and the request for an HTTP error', async () => {
		const { api, Reste } = make();
		ti.respond(() => ({ status: 422, body: { code: 'INVALID', errors: { name: ['required'] } }, headers: { 'X-Request-Id': 'r1', 'Retry-After': '3' } }));
		const error = await rejection(api.post({ body: {} }));
		assert.ok(error instanceof Error);
		assert.ok(error instanceof Reste.ResteError);
		assert.equal(error.name, 'ResteError');
		assert.equal(error.kind, 'http');
		assert.equal(error.isHttp, true);
		assert.equal(error.status, 422);
		assert.deepEqual(error.body, { code: 'INVALID', errors: { name: ['required'] } });
		assert.equal(error.headers['x-request-id'], 'r1');
		assert.equal(error.retryAfter, 3000);
		assert.equal(error.method, 'POST');
		assert.equal(error.url, 'https://api.test/v1/thing');
		assert.equal(error.endpoint, 'post');
		assert.equal(error.attempts, 1);
		assert.ok(error.stack);
	});

	it('keeps a body that is not JSON as text', async () => {
		const { api } = make();
		ti.respond(() => ({ status: 502, text: '<html>Bad gateway</html>', headers: { 'Content-Type': 'text/html' } }));
		const error = await rejection(api.get());
		assert.equal(error.status, 502);
		assert.equal(error.body, '<html>Bad gateway</html>');
	});

	it('tells a dropped connection from a timeout', async () => {
		const { api } = make();
		ti.respond(() => ({ error: 'Connection reset by peer' }));
		let error = await rejection(api.get());
		assert.equal(error.kind, 'network');
		assert.equal(error.isNetwork, true);
		assert.equal(error.status, 0);
		ti.respond(() => ({ error: 'java.net.SocketTimeoutException: timeout' }));
		error = await rejection(api.get());
		assert.equal(error.kind, 'timeout');
		assert.equal(error.isTimeout, true);
		ti.respond(() => ({ error: 'The request timed out.', code: -1001 }));
		assert.equal((await rejection(api.get())).kind, 'timeout');
	});

	it('marks a failure as offline when the device reports no connectivity', async () => {
		const { api } = make();
		ti.Ti.Network.online = false;
		ti.respond(() => ({ error: 'Unable to resolve host' }));
		const error = await rejection(api.get());
		assert.equal(error.kind, 'network');
		assert.equal(error.isOffline, true);
	});

	it('reports JSON that does not parse as a parse error, with the text', async () => {
		const { api } = make();
		ti.respond(() => ({ status: 200, text: '{"data": [1, 2,', headers: { 'Content-Type': 'application/json' } }));
		const error = await rejection(api.get());
		assert.equal(error.kind, 'parse');
		assert.equal(error.isParse, true);
		assert.equal(error.status, 200);
		assert.equal(error.body, '{"data": [1, 2,');
	});

	it('serialises without the HTTP client or request headers', async () => {
		const { api } = make({ requestHeaders: { Authorization: 'Bearer secret' } });
		ti.respond(() => ({ status: 500, body: { message: 'x' } }));
		const text = JSON.stringify(await rejection(api.get()));
		assert.doesNotMatch(text, /secret/);
		assert.match(text, /"status":500/);
	});
});

describe('mapError', () => {
	class ApiError extends Error {
		constructor(code, message, fields) {
			super(message);
			this.code = code;
			this.fields = fields;
		}
	}

	it('turns the API\'s error envelope into the app\'s own error class', async () => {
		const seen = [];
		const { api } = make({
			mapError(error, request) {
				seen.push(request.name);
				if (error.isHttp && error.body && error.body.code) {
					return new ApiError(error.body.code, error.body.message, error.body.errors || {});
				}
				return new ApiError(error.isTimeout ? 'TIMEOUT' : 'NETWORK', error.message, {});
			}
		});
		ti.respond(() => ({ status: 422, body: { code: 'VALIDATION_FAILED', message: 'Fix it', errors: { name: ['required'] } } }));
		const mapped = await rejection(api.post({ body: {} }));
		assert.ok(mapped instanceof ApiError);
		assert.equal(mapped.code, 'VALIDATION_FAILED');
		assert.deepEqual(mapped.fields, { name: ['required'] });
		assert.deepEqual(seen, ['post']);
		ti.respond(() => ({ error: 'timeout' }));
		assert.equal((await rejection(api.get())).code, 'TIMEOUT');
	});

	it('hands the mapped error to callbacks too, and keeps the original when the mapper returns nothing', async () => {
		const { api } = make({ mapError: error => (error.status === 404 ? { notFound: true } : undefined) });
		ti.respond(() => ({ status: 404 }));
		const got = await new Promise(resolve => api.get({}, () => {}, resolve));
		assert.deepEqual(got, { notFound: true });
		ti.respond(() => ({ status: 500 }));
		assert.equal((await rejection(api.get())).kind, 'http');
	});

	it('maps a cancelled and a stale request too, without telling callbacks or hooks about them', async () => {
		const heard = [];
		const { api } = make({
			onError: error => heard.push(error),
			mapError: error => new ApiError(error.isCancelled ? 'CANCELLED' : 'OTHER', error.message, {})
		});
		ti.respond(() => null);
		const cancelled = api.get();
		cancelled.abort();
		const first = await rejection(cancelled);
		assert.ok(first instanceof ApiError);
		assert.equal(first.code, 'CANCELLED');
		const outdated = api.get();
		api.session.reset();
		const second = await rejection(outdated);
		assert.ok(second instanceof ApiError);
		assert.equal(second.code, 'CANCELLED');
		assert.deepEqual(heard, []);
	});

	it('a method can have its own mapper; a mapper that throws rejects with what it threw', async () => {
		const { api } = make({
			mapError: () => 'global',
			methods: [{ name: 'own', get: 'own', mapError: () => 'local' }, { name: 'bad', get: 'bad', mapError: () => { throw new Error('mapper broke'); } }]
		});
		ti.respond(() => ({ status: 500 }));
		assert.equal(await rejection(api.own()), 'local');
		assert.equal((await rejection(api.bad())).message, 'mapper broke');
	});
});

describe('error helpers', () => {
	it('reads Retry-After as seconds or as a date', () => {
		assert.equal(parseRetryAfter('120'), 120000);
		assert.equal(parseRetryAfter('1.5'), 1500);
		assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT')), 10000);
		assert.equal(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:29:00 GMT')), 0);
		assert.equal(parseRetryAfter(null), null);
		assert.equal(parseRetryAfter('soon'), null);
	});

	it('calls a silent failure that lasted the whole timeout a timeout', () => {
		assert.equal(classifyFailure({ error: 'unknown' }, 10020, 10000), 'timeout');
		assert.equal(classifyFailure({ error: 'unknown' }, 300, 10000), 'network');
		assert.equal(classifyFailure(null, 0, 0), 'network');
	});
});
