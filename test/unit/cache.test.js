'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rejection, wait, until } = require('../helpers/setup');
const { parseCacheControl, normalizeCachePolicy, createCache } = require('../../src/cache');

let ti;
afterEach(() => ti && ti.uninstall());

function make(config) {
	const made = setup(Object.assign({
		methods: [
			{ name: 'settings', get: 'config', cache: true },
			{ name: 'catalog', get: 'catalog/<id>', cache: 'etag' },
			{ name: 'ttl', get: 'ttl', cache: { ttl: 30 } },
			{ name: 'swr', get: 'swr', cache: { ttl: 20, staleWhileRevalidate: true } },
			{ name: 'offline', get: 'offline', cache: { ttl: 10, staleIfError: true } },
			{ name: 'uncached', get: 'uncached' },
			{ name: 'update', post: 'config', invalidates: ['settings', 'ttl'] }
		]
	}, config));
	ti = made.ti;
	return made;
}

let served = 0;
function serve(headers, status) {
	served = 0;
	ti.respond(() => ({ status: status || 200, body: { n: ++served }, headers }));
}

describe('caching', () => {
	it('does nothing for methods without a cache policy', async () => {
		const { api } = make();
		serve({ 'Cache-Control': 'max-age=60', ETag: '"a"' });
		await api.uncached();
		await api.uncached();
		assert.equal(ti.requests.length, 2);
		assert.equal(ti.requests[1].headers['If-None-Match'], undefined);
	});

	it('answers from memory while Cache-Control: max-age lasts', async () => {
		const { api } = make();
		serve({ 'Cache-Control': 'public, max-age=60' });
		assert.deepEqual(await api.settings(), { n: 1 });
		const response = await api.settings({}, { fullResponse: true });
		assert.deepEqual(response.data, { n: 1 });
		assert.equal(response.fromCache, true);
		assert.equal(response.stale, false);
		assert.equal(ti.requests.length, 1);
	});

	it('honours no-store and treats no-cache as "always revalidate"', async () => {
		const { api } = make();
		serve({ 'Cache-Control': 'no-store', ETag: '"a"' });
		await api.settings();
		await api.settings();
		assert.equal(ti.requests.length, 2);
		assert.equal(ti.requests[1].headers['If-None-Match'], undefined);
		assert.equal(api.cache.size, 0);
		ti.reset();
		serve({ 'Cache-Control': 'no-cache, max-age=60', ETag: '"b"' });
		await api.settings();
		await api.settings();
		assert.equal(ti.requests[1].headers['If-None-Match'], '"b"');
	});

	it('revalidates with If-None-Match and treats 304 as a cache hit', async () => {
		const { api } = make();
		ti.respond(request => (request.headers['If-None-Match'] === '"v1"'
			? { status: 304, headers: { ETag: '"v1"' } }
			: { status: 200, body: { items: [1, 2] }, headers: { ETag: '"v1"' } }));
		const first = await api.catalog({ id: 1 }, { fullResponse: true });
		const second = await api.catalog({ id: 1 }, { fullResponse: true });
		assert.equal(ti.requests.length, 2);
		assert.equal(first.fromCache, false);
		assert.equal(second.notModified, true);
		assert.equal(second.fromCache, true);
		assert.equal(second.status, 200);
		assert.equal(second.data, first.data); // the same parsed object: no second parse
		assert.equal(second.header('ETag'), '"v1"');
	});

	it('falls back to If-Modified-Since when there is no ETag', async () => {
		const { api } = make();
		ti.respond(request => (request.headers['If-Modified-Since']
			? { status: 304 }
			: { status: 200, body: { a: 1 }, headers: { 'Last-Modified': 'Wed, 21 Oct 2015 07:28:00 GMT' } }));
		await api.catalog({ id: 1 });
		assert.deepEqual(await api.catalog({ id: 1 }), { a: 1 });
		assert.equal(ti.requests[1].headers['If-Modified-Since'], 'Wed, 21 Oct 2015 07:28:00 GMT');
	});

	it('takes a new body when the ETag changed', async () => {
		const { api } = make();
		let version = 1;
		ti.respond(request => (request.headers['If-None-Match'] === '"v' + version + '"'
			? { status: 304 }
			: { status: 200, body: { version }, headers: { ETag: '"v' + version + '"' } }));
		await api.catalog({ id: 1 });
		version = 2;
		assert.deepEqual(await api.catalog({ id: 1 }), { version: 2 });
		assert.deepEqual(await api.catalog({ id: 1 }), { version: 2 });
		assert.equal(ti.requests[2].headers['If-None-Match'], '"v2"');
	});

	it('keys entries by URL, so parameters and query strings do not collide', async () => {
		const { api } = make();
		ti.respond(request => ({ status: 200, body: { url: request.url }, headers: { 'Cache-Control': 'max-age=60' } }));
		const methods = [{ name: 'list', get: 'list', cache: true }];
		api.config({ url: 'https://api.test/v1/', methods });
		await api.list({ query: { page: 1 } });
		await api.list({ query: { page: 2 } });
		await api.list({ query: { page: 1 } });
		assert.equal(ti.requests.length, 2);
	});

	it('a ttl overrides the headers and expires', async () => {
		const { api } = make();
		serve({});
		await api.ttl();
		await api.ttl();
		assert.equal(ti.requests.length, 1);
		await wait(40);
		assert.deepEqual(await api.ttl(), { n: 2 });
	});

	it('force and cache: "reload" skip the cached copy but refresh it; "no-store" bypasses the cache', async () => {
		const { api } = make();
		serve({ 'Cache-Control': 'max-age=60' });
		await api.settings();
		assert.deepEqual(await api.settings({}, { force: true }), { n: 2 });
		assert.deepEqual(await api.settings(), { n: 2 });
		assert.deepEqual(await api.settings({}, { cache: 'reload' }), { n: 3 });
		assert.deepEqual(await api.settings({}, { cache: 'no-store' }), { n: 4 });
		assert.deepEqual(await api.settings(), { n: 3 });
	});

	it('stale-while-revalidate answers at once and refreshes behind the caller', async () => {
		const { api } = make();
		serve({});
		await api.swr();
		await wait(30);
		const updates = [];
		const stale = await api.swr({}, { fullResponse: true, onUpdate: (data, response) => updates.push([data, response.status]) });
		assert.deepEqual(stale.data, { n: 1 });
		assert.equal(stale.stale, true);
		await until(() => updates.length === 1);
		assert.deepEqual(updates[0], [{ n: 2 }, 200]);
		assert.deepEqual(await api.swr(), { n: 2 }); // fresh again
		assert.equal(ti.requests.length, 2);
	});

	it('does not call onUpdate when the revalidation says "not modified"', async () => {
		const { api } = make({ methods: [{ name: 'swr', get: 'swr', cache: { ttl: 5, staleWhileRevalidate: true } }] });
		ti.respond(request => (request.headers['If-None-Match'] ? { status: 304 } : { status: 200, body: { a: 1 }, headers: { ETag: '"e"' } }));
		await api.swr();
		await wait(15);
		let updates = 0;
		await api.swr({}, { onUpdate: () => updates++ });
		await until(() => ti.requests.length === 2);
		await wait(5);
		assert.equal(updates, 0);
	});

	it('stale-if-error answers from the stale copy when the network fails', async () => {
		const { api } = make();
		serve({});
		await api.offline();
		await wait(20);
		ti.respond(() => ({ error: 'offline' }));
		const response = await api.offline({}, { fullResponse: true });
		assert.deepEqual(response.data, { n: 1 });
		assert.equal(response.stale, true);
		ti.respond(() => ({ status: 404 }));
		assert.equal((await rejection(api.offline())).status, 404); // a real answer is not hidden
	});

	it('invalidates by method name, by exact request, by pattern, and after a mutation', async () => {
		const { api } = make();
		serve({ 'Cache-Control': 'max-age=60', ETag: '"x"' });
		await api.settings();
		await api.catalog({ id: 1 });
		await api.catalog({ id: 2 });
		assert.equal(api.cache.size, 3);
		assert.equal(api.cache.invalidate('catalog', { id: 1 }), 1);
		assert.equal(api.cache.size, 2);
		assert.equal(api.cache.invalidate(/catalog/), 1);
		assert.equal(api.cache.invalidate('settings'), 1);
		assert.equal(api.cache.size, 0);
		await api.settings();
		await api.update({ body: {} }); // invalidates: ['settings', 'ttl']
		assert.equal(api.cache.size, 0);
		await api.settings();
		api.cache.clear();
		assert.equal(api.cache.size, 0);
	});

	it('can vary the key on a request header', async () => {
		const { api } = make({ methods: [{ name: 'page', get: 'page', cache: { ttl: 1000, vary: ['Accept-Language'] } }] });
		serve({});
		await api.page({}, { headers: { 'Accept-Language': 'en' } });
		await api.page({}, { headers: { 'Accept-Language': 'fr' } });
		await api.page({}, { headers: { 'accept-language': 'en' } });
		assert.equal(ti.requests.length, 2);
	});

	it('does not cache error responses', async () => {
		const { api } = make();
		serve({ 'Cache-Control': 'max-age=60' }, 500);
		await rejection(api.settings());
		await rejection(api.settings());
		assert.equal(ti.requests.length, 2);
	});

	it('keeps persistent entries across instances and revalidates them', async () => {
		const store = { items: new Map() };
		store.getItem = key => (store.items.has(key) ? store.items.get(key) : null);
		store.setItem = (key, value) => store.items.set(key, value);
		store.removeItem = key => store.items.delete(key);
		store.keys = () => Array.from(store.items.keys());
		const methods = [{ name: 'catalog', get: 'catalog', cache: { persist: true, ttl: 0 } }, { name: 'memory', get: 'memory', cache: { ttl: 1000 } }];
		const first = make({ cache: { store }, methods });
		ti.respond(request => (request.headers['If-None-Match'] === '"p1"' ? { status: 304 } : { status: 200, body: { list: [1, 2, 3] }, headers: { ETag: '"p1"' } }));
		await first.api.catalog();
		await first.api.memory();
		assert.equal(store.items.size, 1); // only the persisted policy reaches the store
		// A new launch: a new instance with the same store.
		const second = new first.Reste();
		second.config({ url: 'https://api.test/v1/', cache: { store }, methods });
		const response = await second.catalog({}, { fullResponse: true });
		assert.equal(ti.last.headers['If-None-Match'], '"p1"');
		assert.equal(response.notModified, true);
		assert.deepEqual(response.data, { list: [1, 2, 3] });
		second.cache.clear();
		assert.equal(store.items.size, 0);
	});

	it('the Titanium property and file stores round-trip', async () => {
		const made = make({});
		for (const store of [made.Reste.propertiesStore(), made.Reste.fileStore('reste-test')]) {
			store.setItem('reste_abc', '{"a":1}');
			assert.equal(store.getItem('reste_abc'), '{"a":1}');
			assert.deepEqual(store.keys().filter(key => key === 'reste_abc'), ['reste_abc']);
			store.removeItem('reste_abc');
			assert.equal(store.getItem('reste_abc'), null);
		}
	});
});

describe('cache internals', () => {
	it('parses Cache-Control', () => {
		assert.deepEqual(parseCacheControl('public, max-age=60, stale-while-revalidate="30"'), { public: true, 'max-age': '60', 'stale-while-revalidate': '30' });
		assert.deepEqual(parseCacheControl(null), {});
	});

	it('normalises policies', () => {
		assert.equal(normalizeCachePolicy(undefined), null);
		assert.equal(normalizeCachePolicy(false), null);
		assert.equal(normalizeCachePolicy(true).respectHeaders, true);
		assert.equal(normalizeCachePolicy('etag').ttl, 0);
		assert.equal(normalizeCachePolicy(5000).ttl, 5000);
		assert.equal(normalizeCachePolicy({ persist: true }).persist, true);
	});

	it('drops the least recently used entry past maxEntries', () => {
		const cache = createCache({ maxEntries: 2 });
		const policy = normalizeCachePolicy(1000);
		['a', 'b'].forEach(key => cache.store(key, 't', policy, { status: 200, body: key, headers: {} }));
		cache.lookup('a'); // a is now the most recent
		cache.store('c', 't', policy, { status: 200, body: 'c', headers: {} });
		assert.ok(cache.lookup('a'));
		assert.equal(cache.lookup('b'), null);
		assert.ok(cache.lookup('c'));
	});

	it('uses the server\'s stale-while-revalidate window', () => {
		let now = 1000;
		const cache = createCache({ now: () => now });
		cache.store('k', 't', normalizeCachePolicy(true), { status: 200, body: 1, headers: { 'cache-control': 'max-age=1, stale-while-revalidate=2' } });
		assert.equal(cache.lookup('k').fresh, true);
		now += 1500;
		assert.deepEqual([cache.lookup('k').fresh, cache.lookup('k').usableStale], [false, true]);
		now += 2000;
		assert.equal(cache.lookup('k').usableStale, false);
	});
});
