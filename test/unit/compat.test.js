'use strict';

/* Upstream 1.x behaviour that existing apps rely on, and the places where 2.0 deliberately differs. */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rejection, wait } = require('../helpers/setup');

let ti;
afterEach(() => ti && ti.uninstall());

function make(config) {
	const made = setup(Object.assign({ methods: [{ name: 'getVideos', get: 'videos' }, { name: 'getVideo', get: 'videos/<id>' }, { name: 'addVideo', post: 'videos' }] }, config));
	ti = made.ti;
	ti.respond(() => ({ status: 200, body: { ok: true } }));
	return made;
}

function callback() {
	const calls = [];
	const fn = function () {
		calls.push(Array.prototype.slice.call(arguments));
	};
	fn.calls = calls;
	return fn;
}

describe('callbacks (upstream API)', () => {
	it('method(params, onLoad, onError) calls onLoad with the body', async () => {
		const { api } = make();
		const onLoad = callback();
		const onError = callback();
		api.getVideo({ id: 1 }, onLoad, onError);
		await wait(5);
		assert.deepEqual(onLoad.calls[0][0], { ok: true });
		assert.equal(onLoad.calls[0][1].status, 200); // new: the response is the second argument
		assert.equal(onError.calls.length, 0);
	});

	it('method(onLoad) works without params', async () => {
		const { api } = make();
		const onLoad = callback();
		api.getVideos(onLoad);
		await wait(5);
		assert.equal(onLoad.calls.length, 1);
	});

	it('method(onLoad, onError) keeps the two apart', async () => {
		// Upstream used the second function as the success callback.
		const { api } = make();
		ti.respond(() => ({ status: 500, body: { message: 'boom' } }));
		const onLoad = callback();
		const onError = callback();
		api.getVideos(onLoad, onError);
		await wait(5);
		assert.equal(onLoad.calls.length, 0);
		assert.equal(onError.calls.length, 1);
	});

	it('returns something with abort(), as upstream returned the HTTP client', async () => {
		const { api } = make();
		ti.respond(() => null);
		const handle = api.getVideos(callback(), callback());
		assert.equal(typeof handle.abort, 'function');
		handle.abort();
		assert.equal(ti.last.aborted, true);
		await wait(5);
	});

	it('gives promises without Q: the unreachable promise return of upstream is fixed', async () => {
		const { api } = make({ Q: { defer() { throw new Error('Q is not needed'); } } });
		const promise = api.getVideos();
		assert.equal(typeof promise.then, 'function');
		assert.deepEqual(await promise, { ok: true });
	});

	it('errors go to onError with a retry function', async () => {
		const { api } = make();
		ti.respond(() => ({ status: 503, body: { message: 'later' } }));
		const onLoad = callback();
		const onError = callback();
		api.getVideos(onLoad, onError);
		await wait(5);
		const [error, retry] = onError.calls[0];
		assert.equal(error.code, 503);
		assert.deepEqual(error.content, { message: 'later' });
		assert.equal(error.success, false);
		assert.equal(error.type, 'error');
		assert.equal(typeof error.error, 'string');
		assert.equal(error.url, 'https://api.test/v1/videos');
		ti.respond(() => ({ status: 200, body: { ok: 'second' } }));
		retry();
		await wait(5);
		assert.deepEqual(onLoad.calls[0][0], { ok: 'second' });
	});

	it('errorsAsObjects: false still hands callbacks the parsed body only', async () => {
		const { api } = make({ errorsAsObjects: false });
		ti.respond(() => ({ status: 422, body: { message: 'invalid' } }));
		const onError = callback();
		const handle = api.getVideos(callback(), onError);
		await wait(5);
		assert.deepEqual(onError.calls[0][0], { message: 'invalid' });
		const error = await rejection(handle); // the promise always carries the error object
		assert.equal(error.status, 422);
	});

	it('uses config.onError when the call has no error callback', async () => {
		const onError = callback();
		const { api } = make({ onError });
		ti.respond(() => ({ status: 500 }));
		const onLoad = callback();
		api.getVideos(onLoad);
		await wait(5);
		assert.equal(onError.calls.length, 1);
		assert.equal(typeof onError.calls[0][1], 'function');
		assert.equal(onLoad.calls.length, 0);
	});

	it('prefers the call\'s error callback over config.onError', async () => {
		const globalError = callback();
		const { api } = make({ onError: globalError });
		ti.respond(() => ({ status: 500 }));
		const onError = callback();
		api.getVideos(callback(), onError);
		await wait(5);
		assert.equal(onError.calls.length, 1);
		assert.equal(globalError.calls.length, 0);
	});

	it('a method\'s onError wins over both, and can hand a value to the success callback', async () => {
		const globalError = callback();
		const { api } = make({
			onError: globalError,
			methods: [{ name: 'courses', post: 'courses', onError: (error, done) => done({ recovered: error.code }) }]
		});
		ti.respond(() => ({ status: 500 }));
		const onLoad = callback();
		const onError = callback();
		api.courses({}, onLoad, onError);
		await wait(5);
		assert.deepEqual(onLoad.calls[0][0], { recovered: 500 });
		assert.equal(onError.calls.length, 0);
		assert.equal(globalError.calls.length, 0);
	});

	it('no longer passes errors to the success callback unless errorsToOnLoad is set', async () => {
		let made = make({ logger: () => {} });
		ti.respond(() => ({ status: 500, body: { message: 'x' } }));
		const quiet = callback();
		made.api.getVideos(quiet);
		await wait(5);
		assert.equal(quiet.calls.length, 0);
		ti.uninstall();
		made = make({ errorsToOnLoad: true });
		ti.respond(() => ({ status: 500, body: { message: 'x' } }));
		const loud = callback();
		made.api.getVideos(loud);
		await wait(5);
		assert.equal(loud.calls[0][0].code, 500);
		assert.equal(typeof loud.calls[0][1], 'function');
	});

	it('warns instead of throwing when nothing handles an error', async () => {
		const logged = [];
		const { api } = make({ logger: (level, message) => logged.push(message) });
		ti.respond(() => ({ status: 500 }));
		api.getVideos(callback());
		await wait(5);
		assert.match(logged.join('\n'), /unhandled error for getVideos/);
	});

	it('rejects the promise as well when a callback handled the error, without an unhandled rejection', async () => {
		const { api } = make();
		ti.respond(() => ({ status: 500 }));
		const handle = api.getVideos(callback(), callback());
		await wait(5);
		assert.equal((await rejection(handle)).status, 500);
	});
});

describe('onLoad hooks (upstream API)', () => {
	it('config.onLoad sees the body first and decides what goes on', async () => {
		const { api } = make({ onLoad: (body, next) => next({ wrapped: body }) });
		assert.deepEqual(await api.getVideos(), { wrapped: { ok: true } });
		const onLoad = callback();
		api.getVideos(onLoad);
		await wait(5);
		assert.deepEqual(onLoad.calls[0][0], { wrapped: { ok: true } });
	});

	it('a method\'s onLoad runs after config.onLoad', async () => {
		const order = [];
		const { api } = make({
			onLoad: (body, next) => {
				order.push('global');
				next(body);
			},
			methods: [{
				name: 'list', get: 'list', onLoad: (body, next) => {
					order.push('method');
					next(Object.assign({ local: true }, body));
				}
			}]
		});
		assert.deepEqual(await api.list(), { local: true, ok: true });
		assert.deepEqual(order, ['global', 'method']);
	});

	it('a hook that never calls back stops the call, as upstream', async () => {
		const { api } = make({ onLoad: () => {} });
		const onLoad = callback();
		api.getVideos(onLoad);
		await wait(10);
		assert.equal(onLoad.calls.length, 0);
		assert.equal(api.abortAll(), 0); // and the finished request is not kept as "in flight"
	});
});

describe('beforeSend and beforePost (upstream API)', () => {
	it('beforeSend can change the body of any request', async () => {
		const { api } = make({ beforeSend: (body, next) => next(Object.assign({ stamped: true }, body)) });
		await api.addVideo({ body: { a: 1 } });
		assert.deepEqual(ti.last.json, { stamped: true, a: 1 });
	});

	it('beforePost runs first for POST, then beforeSend, as the README always said', async () => {
		const order = [];
		const { api } = make({
			beforePost: (body, next) => {
				order.push('post');
				next(Object.assign({}, body, { post: true }));
			},
			beforeSend: (body, next) => {
				order.push('send');
				next(Object.assign({}, body, { send: true }));
			}
		});
		await api.addVideo({ body: {} });
		assert.deepEqual(order, ['post', 'send']);
		assert.deepEqual(ti.last.json, { post: true, send: true });
		order.length = 0;
		await api.getVideos();
		assert.deepEqual(order, ['send']);
	});

	it('a method\'s hook replaces the global one', async () => {
		const { api } = make({
			beforeSend: (body, next) => next({ from: 'global' }),
			methods: [{ name: 'special', post: 'special', beforeSend: (body, next) => next({ from: 'method' }) }]
		});
		await api.special({ body: {} });
		assert.deepEqual(ti.last.json, { from: 'method' });
	});

	it('{ skip: true } stops the request and goes to the success callback', async () => {
		const { api } = make({ beforeSend: (body, next) => next({ skip: true, error: 'no_internet' }) });
		const onLoad = callback();
		api.getVideos(onLoad);
		await wait(5);
		assert.deepEqual(onLoad.calls[0][0], { skip: true, error: 'no_internet' });
		assert.equal(ti.requests.length, 0);
		assert.deepEqual(await api.getVideos(), { skip: true, error: 'no_internet' }); // upstream threw without a callback
	});

	it('hooks see the original body again when the legacy retry() is used', async () => {
		// Upstream re-ran the hook on its own output.
		const seen = [];
		const { api } = make({
			beforeSend: (body, next) => {
				seen.push(JSON.stringify(body));
				next(Object.assign({}, body, { n: (body.n || 0) + 1 }));
			}
		});
		ti.respond(() => ({ status: 500 }));
		const onError = callback();
		api.addVideo({ body: { n: 1 } }, callback(), onError);
		await wait(5);
		onError.calls[0][1]();
		await wait(5);
		assert.deepEqual(seen, ['{"n":1}', '{"n":1}']);
		assert.deepEqual(ti.requests.map(request => request.json), [{ n: 2 }, { n: 2 }]);
	});
});

describe('expects and parameter validation (upstream API)', () => {
	it('rejects when an expected parameter is missing from params and body', async () => {
		const { api } = make({ methods: [{ name: 'update', put: 'x/<id>', expects: ['id', 'name'] }] });
		const error = await rejection(api.update({ id: 1, body: { other: true } }));
		assert.equal(error.kind, 'params');
		assert.match(error.message, /missing parameter name for method update/);
	});

	it('accepts falsy but present values', async () => {
		// Upstream treated 0, false and '' as missing.
		const { api } = make({ methods: [{ name: 'update', put: 'x/<id>', expects: ['id', 'count'] }] });
		await api.update({ id: 0, body: { count: 0 } });
		assert.equal(ti.last.url, 'https://api.test/v1/x/0');
	});

	it('does not need params at all to report a missing one', async () => {
		const { api } = make({ methods: [{ name: 'update', put: 'x', expects: ['name'] }] });
		assert.equal((await rejection(api.update())).kind, 'params'); // upstream: TypeError
	});

	it('delivers validation failures to the error callback, not as a throw', async () => {
		const { api } = make({ autoValidateParams: true });
		const onError = callback();
		assert.doesNotThrow(() => api.getVideo({}, callback(), onError));
		await wait(5);
		assert.equal(onError.calls[0][0].kind, 'params');
	});
});
