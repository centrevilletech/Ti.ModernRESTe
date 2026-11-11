'use strict';

/* Things that go wrong only when two requests overlap, and what is kept on disk. */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rejection, wait } = require('../helpers/setup');
const { eachBackbone, installAlloy, uninstallAlloy } = require('../helpers/backbone');

let ti;
afterEach(() => ti && ti.uninstall());

function memoryStore() {
	const items = new Map();
	return {
		items,
		getItem: key => (items.has(key) ? items.get(key) : null),
		setItem: (key, value) => items.set(key, value),
		removeItem: key => items.delete(key),
		keys: () => Array.from(items.keys())
	};
}

describe('cache invalidation and requests in flight', () => {
	const methods = policy => [
		{ name: 'getArticles', get: 'articles', cache: policy },
		{ name: 'updateArticle', put: 'articles/<id>', invalidates: ['getArticles'] }
	];

	it('a GET sent before a write that invalidates it is not stored when it lands afterwards', async () => {
		const made = setup({ methods: methods({ ttl: 60000 }) });
		ti = made.ti;
		const api = made.api;
		ti.respond(() => ({ status: 200, body: [{ id: 1, v: 'old' }], headers: { ETag: '"e1"' } }));
		await api.getArticles();
		ti.respond(request => (request.method === 'GET'
			? { status: 200, body: [{ id: 1, v: 'old' }], headers: { ETag: '"e1"' }, delay: 40 }
			: { status: 200, body: { id: 1, v: 'new' } }));
		const early = api.getArticles({}, { cache: 'reload' });
		await wait(5);
		await api.updateArticle({ id: 1, body: { v: 'new' } });
		assert.equal(api.cache.size, 0);
		assert.deepEqual(await early, [{ id: 1, v: 'old' }]); // the caller still gets its answer
		assert.equal(api.cache.size, 0); // but it is not kept as fresh
		ti.respond(() => ({ status: 200, body: [{ id: 1, v: 'new' }] }));
		const next = await api.getArticles({}, { fullResponse: true });
		assert.equal(next.fromCache, false);
		assert.deepEqual(next.data, [{ id: 1, v: 'new' }]);
	});

	it('a 304 that lands after an invalidation does not bring the entry back', async () => {
		const made = setup({ methods: methods('etag') });
		ti = made.ti;
		const api = made.api;
		ti.respond(() => ({ status: 200, body: [{ id: 1, v: 'old' }], headers: { ETag: '"e1"' } }));
		await api.getArticles();
		ti.respond(request => (request.method === 'GET' ? { status: 304, delay: 40 } : { status: 200, body: {} }));
		const revalidating = api.getArticles();
		await wait(5);
		await api.updateArticle({ id: 1, body: { v: 'new' } });
		assert.equal(api.cache.size, 0);
		await revalidating;
		assert.equal(api.cache.size, 0);
	});

	it('an exact invalidation and clear() protect against requests in flight as well', async () => {
		const made = setup({ methods: methods({ ttl: 60000 }) });
		ti = made.ti;
		const api = made.api;
		for (const drop of [() => api.cache.invalidate('getArticles', {}), () => api.cache.clear(), () => api.cache.invalidate(/articles/)]) {
			ti.respond(() => ({ status: 200, body: [1], delay: 20 }));
			const early = api.getArticles({}, { cache: 'reload' });
			await wait(5);
			drop();
			await early;
			assert.equal(api.cache.size, 0);
		}
		ti.respond(() => ({ status: 200, body: [2] }));
		await api.getArticles();
		assert.equal(api.cache.size, 1); // later requests are cached again
	});

	it('invalidating by method name also drops entries a previous launch persisted', async () => {
		const store = memoryStore();
		const config = () => ({
			url: 'https://api.test/v1/',
			cache: { store },
			methods: [
				{ name: 'getCategories', get: 'categories', cache: { ttl: 3600000, persist: true } },
				{ name: 'getOthers', get: 'others', cache: { ttl: 3600000, persist: true } },
				{ name: 'putCategory', put: 'categories/<id>', invalidates: ['getCategories'] }
			]
		});
		const first = setup(config());
		ti = first.ti;
		ti.respond(() => ({ status: 200, body: [{ id: 1, n: 'old' }] }));
		await first.api.getCategories();
		await first.api.getOthers();
		assert.equal(store.items.size, 2);
		// The app restarts: a new instance, nothing in memory.
		const second = new first.Reste();
		second.config(config());
		ti.respond(request => (request.method === 'PUT' ? { status: 200, body: {} } : { status: 200, body: [{ id: 1, n: 'new' }] }));
		await second.putCategory({ id: 1, body: { n: 'new' } });
		assert.equal(store.items.size, 1);
		const response = await second.getCategories({}, { fullResponse: true });
		assert.equal(response.fromCache, false);
		assert.deepEqual(response.data, [{ id: 1, n: 'new' }]);
		assert.equal((await second.getOthers({}, { fullResponse: true })).fromCache, true);
		assert.equal(second.cache.invalidate(/others/), 1);
		assert.equal(store.items.size, 1);
	});

	it('a reload does not join a conditional request of the same URL', async () => {
		const made = setup({ dedupe: true, methods: [{ name: 'getArticles', get: 'articles', cache: 'etag' }] });
		ti = made.ti;
		const api = made.api;
		ti.respond(() => ({ status: 200, body: [{ id: 1 }], headers: { ETag: '"e1"' } }));
		await api.getArticles();
		ti.respond(request => (request.headers['If-None-Match'] ? { status: 304, delay: 20 } : { status: 200, body: [{ id: 1 }], headers: { ETag: '"e1"' }, delay: 20 }));
		const [normal, reloaded] = await Promise.all([api.getArticles(), api.getArticles({}, { cache: 'reload' })]);
		assert.deepEqual(normal, [{ id: 1 }]);
		assert.deepEqual(reloaded, [{ id: 1 }]);
	});
});

describe('what the persistent cache keeps', () => {
	it('only the headers it needs: no cookies, no other response headers', async () => {
		const store = memoryStore();
		const made = setup({ cache: { store }, methods: [{ name: 'me', get: 'me', cache: { persist: true, ttl: 1000 } }] });
		ti = made.ti;
		ti.respond(() => ({ status: 200, body: { name: 'Ada' }, headers: { 'Set-Cookie': 'session=SECRET-COOKIE; HttpOnly', ETag: '"x"', 'Cache-Control': 'max-age=60', 'X-Internal': 'SECRET-HEADER' } }));
		const live = await made.api.me({}, { fullResponse: true });
		assert.equal(live.header('X-Internal'), 'SECRET-HEADER'); // the live response has everything
		const stored = Array.from(store.items.values()).join('\n');
		assert.doesNotMatch(stored, /SECRET/);
		assert.match(stored, /"etag":"\\"x\\""/);
		assert.match(stored, /Ada/);
	});

	it('nothing that varies on a credential header, and nothing for Vary: *', async () => {
		const store = memoryStore();
		const made = setup({
			cache: { store },
			requestHeaders: { Authorization: 'Bearer A' },
			methods: [{ name: 'me', get: 'me', cache: { persist: true, ttl: 60000 } }, { name: 'any', get: 'any', cache: { persist: true, ttl: 60000 } }]
		});
		ti = made.ti;
		ti.respond(request => ({ status: 200, body: { who: request.headers.Authorization }, headers: { Vary: request.url.indexOf('any') === -1 ? 'Authorization, Accept-Language' : '*' } }));
		await made.api.me();
		await made.api.any();
		assert.equal(store.items.size, 0);
		assert.equal(made.api.cache.size, 1); // memory may hold the first: it is checked against the header below
		await made.api.any();
		assert.equal(ti.requests.length, 3); // Vary: * is never served from the cache
	});

	it('honours Vary: another value of a varying header is a miss', async () => {
		const made = setup({ methods: [{ name: 'page', get: 'page', cache: { ttl: 60000 } }] });
		ti = made.ti;
		ti.respond(request => ({ status: 200, body: { lang: request.headers['Accept-Language'] }, headers: { Vary: 'Accept-Language' } }));
		assert.deepEqual(await made.api.page({}, { headers: { 'Accept-Language': 'en' } }), { lang: 'en' });
		assert.deepEqual(await made.api.page({}, { headers: { 'Accept-Language': 'en' } }), { lang: 'en' });
		assert.equal(ti.requests.length, 1);
		assert.deepEqual(await made.api.page({}, { headers: { 'Accept-Language': 'fr' } }), { lang: 'fr' });
		assert.equal(ti.requests.length, 2);
	});

	it('a token that changed without a session reset does not get the previous user\'s answer', async () => {
		let token = 'A';
		const made = setup({ requestHeaders: { Authorization: () => 'Bearer ' + token }, methods: [{ name: 'me', get: 'me', cache: { ttl: 60000 } }] });
		ti = made.ti;
		ti.respond(request => ({ status: 200, body: { who: request.headers.Authorization }, headers: { Vary: 'Authorization' } }));
		assert.deepEqual(await made.api.me(), { who: 'Bearer A' });
		token = 'B';
		assert.deepEqual(await made.api.me(), { who: 'Bearer B' });
	});

	it('cache.scope separates users even when the server sends no Vary', async () => {
		let user = 'a';
		const made = setup({ cache: { scope: () => user }, methods: [{ name: 'me', get: 'me', cache: { ttl: 60000 } }] });
		ti = made.ti;
		let served = 0;
		ti.respond(() => ({ status: 200, body: { n: ++served } }));
		assert.deepEqual(await made.api.me(), { n: 1 });
		user = 'b';
		assert.deepEqual(await made.api.me(), { n: 2 });
		user = 'a';
		assert.deepEqual(await made.api.me(), { n: 1 });
	});
});

describe('maps that must not grow without bound', () => {
	it('a method whose URL is a function keeps only a few compiled variants', async () => {
		let n = 0;
		const made = setup({ methods: [{ name: 'dyn', get: () => 'https://host' + (++n) + '.test/x' }] });
		ti = made.ti;
		ti.respond(() => ({ status: 200, body: {} }));
		for (let i = 0; i < 200; i++) {
			await made.api.dyn();
		}
		assert.ok(made.api.inspect().variants.dyn <= 32, 'variants kept: ' + made.api.inspect().variants.dyn);
		assert.equal(ti.last.url, 'https://host200.test/x');
	});
});

eachBackbone((Backbone, version) => {
	describe('overlapping requests on collections, Backbone ' + version, () => {
		let api;
		let articles;

		beforeEach(() => {
			installAlloy(Backbone);
			const made = setup({
				meta: 'meta',
				methods: [
					{ name: 'getArticles', get: 'articles', paginate: { style: 'page', perPage: 2 } },
					{ name: 'getAll', get: 'all' },
					{ name: 'getArticle', get: 'articles/<id>' },
					{ name: 'createArticle', post: 'articles' },
					{ name: 'patchArticle', patch: 'articles/<id>' },
					{ name: 'updateArticle', put: 'articles/<id>' },
					{ name: 'deleteArticle', delete: 'articles/<id>' }
				],
				models: [{
					name: 'article',
					read: 'getArticle',
					create: 'createArticle',
					update: 'updateArticle',
					patch: 'patchArticle',
					delete: 'deleteArticle',
					identity: version !== '1.1.2', // with and without an identity map
					collections: [
						{ name: 'articles', read: 'getAll', merge: true },
						{ name: 'paged', read: 'getArticles', content: 'data', merge: true }
					]
				}]
			});
			ti = made.ti;
			api = made.api;
			articles = Alloy.Collections.articles;
		});
		afterEach(() => uninstallAlloy());

		const list = () => [{ id: 1, title: 'a', fav: false }, { id: 2, title: 'b', fav: false }];

		it('an optimistic destroy is not undone by a refresh that was already on its way', async () => {
			ti.respond(() => ({ status: 200, body: list() }));
			await articles.fetch();
			ti.respond(request => (request.method === 'GET' ? { status: 200, body: list(), delay: 20 } : { status: 204, delay: 40 }));
			const refresh = articles.refresh();
			await wait(2);
			const destroying = articles.get(2).destroy({ optimistic: true });
			assert.deepEqual(articles.pluck('id'), [1]);
			await refresh;
			assert.deepEqual(articles.pluck('id'), [1], 'the refresh brought the row back');
			await destroying;
			await wait(10);
			assert.deepEqual(articles.pluck('id'), [1]);
		});

		it('nor by a page, an upsert or a list load that lands while it is being destroyed', async () => {
			ti.respond(() => ({ status: 200, body: list() }));
			await articles.fetch();
			ti.respond(request => (request.method === 'DELETE' ? { status: 204, delay: 40 } : { status: 200, body: list(), delay: 5 }));
			const destroying = articles.get(2).destroy({ optimistic: true });
			articles.upsert(list()); // a socket message that still mentions it
			assert.deepEqual(articles.pluck('id'), [1]);
			const following = api.list({ collection: articles });
			await following.load();
			assert.deepEqual(articles.pluck('id'), [1]);
			await destroying;
			await wait(10);
			articles.upsert([{ id: 2, title: 'created again by someone' }]); // afterwards the id is free again
			assert.deepEqual(articles.pluck('id'), [1, 2]);
		});

		it('a refresh sent before a write and landing after the write\'s answer does not undo it either', async () => {
			ti.respond(() => ({ status: 200, body: list() }));
			await articles.fetch();
			ti.respond(request => (request.method === 'GET' ? { status: 200, body: list(), delay: 40 } : { status: 204, delay: 5 }));
			const refresh = articles.refresh();
			await wait(2);
			const saving = articles.get(1).save({ fav: true }, { optimistic: true, patch: true });
			const destroying = articles.get(2).destroy({ optimistic: true });
			await saving;
			await destroying;
			await refresh; // asked for before both writes, answered after them
			assert.equal(articles.get(1).get('fav'), true);
			assert.deepEqual(articles.pluck('id'), [1]);
			ti.respond(() => ({ status: 200, body: [{ id: 1, title: 'a', fav: false }] }));
			await articles.refresh(); // a refresh asked for afterwards is the server's word again
			assert.equal(articles.get(1).get('fav'), false);
		});

		it('an optimistic destroy that the server refuses comes back, also after a refresh in between', async () => {
			ti.respond(() => ({ status: 200, body: list() }));
			await articles.fetch();
			ti.respond(request => (request.method === 'GET' ? { status: 200, body: list(), delay: 10 } : { status: 409, delay: 40 }));
			const refresh = articles.refresh();
			await wait(2);
			const destroying = articles.get(2).destroy({ optimistic: true });
			await refresh;
			await rejection(destroying);
			assert.deepEqual(articles.pluck('id').sort(), [1, 2]);
		});

		it('an optimistic change is not reverted by a refresh that was already on its way', async () => {
			ti.respond(() => ({ status: 200, body: list() }));
			await articles.fetch();
			ti.respond(request => (request.method === 'GET' ? { status: 200, body: list(), delay: 20 } : { status: 204, delay: 40 }));
			const refresh = articles.refresh();
			await wait(2);
			const saving = articles.get(1).save({ fav: true }, { optimistic: true, patch: true });
			await refresh;
			assert.equal(articles.get(1).get('fav'), true, 'the stale refresh overwrote the change');
			assert.equal(articles.get(1).get('title'), 'a');
			await saving;
			await wait(10);
			assert.equal(articles.get(1).get('fav'), true);
		});

		it('a model being created is not dropped by a refresh, and gets its id afterwards', async () => {
			ti.respond(() => ({ status: 200, body: list() }));
			await articles.fetch();
			ti.respond(request => (request.method === 'GET' ? { status: 200, body: list(), delay: 10 } : { status: 201, body: { id: 3, title: 'new' }, delay: 40 }));
			const created = articles.create({ title: 'new' }, { optimistic: true });
			await articles.refresh();
			assert.equal(articles.length, 3, 'the refresh dropped the row that is being created');
			await wait(60);
			assert.equal(created.id, 3);
			assert.deepEqual(articles.pluck('id').sort(), [1, 2, 3]);
		});

		it('a chunked refresh does not bring back a row destroyed between its chunks', async () => {
			const many = Array.from({ length: 30 }, (unused, index) => ({ id: index + 1 }));
			ti.respond(() => ({ status: 200, body: many }));
			await articles.fetch();
			ti.respond(request => (request.method === 'GET' ? { status: 200, body: many.map(item => Object.assign({ touched: true }, item)), delay: 1 } : { status: 204, delay: 30 }));
			const refresh = articles.refresh({ chunk: 10 });
			await wait(4);
			articles.get(30).destroy({ optimistic: true });
			await refresh;
			assert.equal(articles.get(30), undefined);
			assert.equal(articles.length, 29);
		});

		it('a session reset starts the collections\' paging over', async () => {
			const paged = Alloy.Collections.paged;
			ti.respond((request) => {
				const page = Number(/page=(\d+)/.exec(request.url)[1]);
				return { status: 200, body: { data: [{ id: page * 10 }, { id: page * 10 + 1 }], meta: { current_page: page, last_page: 5 } } };
			});
			await paged.fetch();
			await paged.fetchNext();
			await paged.fetchNext();
			assert.equal(paged.paging.page, 3);
			api.session.reset({ resetCollections: true });
			assert.equal(paged.paging, null);
			assert.equal(paged.hasMore(), false);
			await paged.fetchNext(); // the next user's first load
			assert.match(ti.last.url, /page=1&/);
			assert.deepEqual(paged.pluck('id'), [10, 11]);
		});
	});

	describe('identity maps on Backbone ' + version, () => {
		beforeEach(() => installAlloy(Backbone));
		afterEach(() => uninstallAlloy());

		it('keep at most `limit` models that no collection holds', async () => {
			const made = setup({
				identity: { limit: 50, weak: false },
				methods: [{ name: 'getArticle', get: 'articles/<id>' }, { name: 'getArticles', get: 'articles' }],
				models: [{ name: 'article', read: 'getArticle', collections: [{ name: 'articles', read: 'getArticles', merge: true }] }]
			});
			ti = made.ti;
			ti.respond(() => ({ status: 200, body: [{ id: 1 }, { id: 2 }] }));
			await Alloy.Collections.articles.fetch();
			const held = Alloy.Collections.articles.get(1);
			for (let id = 100; id < 1100; id++) {
				made.api.model('article', id); // a detail screen per id, long gone
			}
			assert.ok(made.api.identity.size('article') <= 52, 'kept ' + made.api.identity.size('article'));
			assert.equal(made.api.model('article', 1), held); // models a collection holds are never dropped
			assert.equal(made.api.model('article', 1099), made.api.model('article', 1099));
		});

		it('with weak references a model lives as long as something holds it', async () => {
			const made = setup({
				identity: true,
				methods: [{ name: 'getArticle', get: 'articles/<id>' }],
				models: [{ name: 'article', read: 'getArticle' }]
			});
			ti = made.ti;
			const kept = made.api.model('article', 7);
			assert.equal(made.api.model('article', 7), kept);
			assert.equal(made.api.identity.get('article', 7), kept);
		});
	});
});
