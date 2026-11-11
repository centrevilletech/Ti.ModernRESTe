'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rejection, wait } = require('../helpers/setup');

let ti;
afterEach(() => ti && ti.uninstall());

function make(config) {
	const made = setup(Object.assign({ methods: [{ name: 'get', get: 'thing/<id>' }, { name: 'list', get: 'things' }] }, config));
	ti = made.ti;
	ti.respond(() => null);
	return made;
}

describe('cancellation', () => {
	it('abort() after send stops the HTTP client and rejects as cancelled', async () => {
		const { api } = make();
		const handle = api.list();
		assert.equal(handle.abort(), true);
		assert.equal(ti.last.aborted, true);
		const error = await rejection(handle);
		assert.equal(error.kind, 'cancelled');
		assert.equal(error.isCancelled, true);
		assert.equal(handle.abort(), false); // already over
	});

	it('a response that arrives after abort() is ignored', async () => {
		const { api } = make();
		const loaded = [];
		const handle = api.list(body => loaded.push(body), error => loaded.push(error));
		handle.abort();
		ti.last.settled = false;
		ti.last.respond({ status: 200, body: {} });
		await wait(5);
		assert.deepEqual(loaded, []); // a cancelled request calls nobody back
	});

	it('abort() before send: nothing goes out while an interceptor is still working', async () => {
		const { api } = make({ interceptors: { request: () => wait(10) } });
		const handle = api.list();
		handle.abort();
		assert.equal((await rejection(handle)).kind, 'cancelled');
		await wait(20);
		assert.equal(ti.requests.length, 0);
	});

	it('abort() during a retry back-off prevents the next attempt', async () => {
		const { api } = make({ retry: { retries: 2, baseDelay: 20, jitter: 0 } });
		ti.respond(() => ({ status: 503 }));
		const handle = api.list();
		await wait(5);
		assert.equal(ti.requests.length, 1);
		handle.abort();
		await wait(40);
		assert.equal(ti.requests.length, 1);
		assert.equal((await rejection(handle)).kind, 'cancelled');
	});

	it('abort() during a retry back-off leaves no timer behind', async () => {
		const timers = () => process.getActiveResourcesInfo().filter(name => name === 'Timeout').length;
		const { api } = make({ retry: { retries: 2, baseDelay: 60000, jitter: 0 } });
		ti.respond(() => ({ status: 503 }));
		const before = timers();
		const handle = api.list();
		await wait(5);
		assert.equal(timers(), before + 1); // waiting a minute for the second attempt
		handle.abort();
		assert.equal(timers(), before);
		await rejection(handle);
	});

	it('a signal cancels every request it was given', async () => {
		const { api, Reste } = make();
		const controller = Reste.createAbortController();
		const first = api.list({}, { signal: controller.signal });
		const second = api.get({ id: 1 }, { signal: controller.signal });
		const other = api.get({ id: 2 });
		controller.abort('screen closed');
		assert.equal((await rejection(first)).kind, 'cancelled');
		assert.equal((await rejection(second)).reason, 'screen closed');
		assert.deepEqual(ti.requests.map(request => request.aborted), [true, true, false]);
		other.abort();
		await rejection(other);
	});

	it('a signal that is already aborted rejects without sending', async () => {
		const { api } = make();
		const controller = api.createAbortController();
		controller.abort();
		assert.equal((await rejection(api.list({}, { signal: controller.signal }))).kind, 'cancelled');
		assert.equal(ti.requests.length, 0);
	});

	it('stops listening to the signal once the request is over', async () => {
		const { api, Reste } = make();
		const controller = Reste.createAbortController();
		let listeners = 0;
		const add = controller.signal.addEventListener;
		const remove = controller.signal.removeEventListener;
		controller.signal.addEventListener = function () {
			listeners++;
			return add.apply(this, arguments);
		};
		controller.signal.removeEventListener = function () {
			listeners--;
			return remove.apply(this, arguments);
		};
		ti.respond(() => ({ status: 200, body: {} }));
		await api.list({}, { signal: controller.signal });
		assert.equal(listeners, 0);
	});

	it('abortAll() cancels everything in flight, or what a filter picks', async () => {
		const { api } = make();
		const a = api.list();
		const b = api.get({ id: 1 });
		assert.equal(api.abortAll(request => request.name === 'get'), 1);
		assert.equal((await rejection(b)).kind, 'cancelled');
		assert.equal(api.abortAll(), 1);
		assert.equal((await rejection(a)).kind, 'cancelled');
	});

	it('a deadline ends the request as a timeout, whatever the retries are doing', async () => {
		const { api } = make({ retry: { retries: 5, baseDelay: 10, jitter: 0 } });
		ti.respond(() => ({ status: 503 }));
		const started = Date.now();
		const error = await rejection(api.list({}, { deadline: 35 }));
		assert.equal(error.kind, 'timeout');
		assert.ok(Date.now() - started < 200);
		const sent = ti.requests.length;
		await wait(40);
		assert.equal(ti.requests.length, sent);
	});
});
