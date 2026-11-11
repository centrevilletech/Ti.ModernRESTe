'use strict';

/* What is loaded when: requests need the core; models, collections, lists and pagination load on first use. */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, Reste } = require('../helpers/setup');
const { load: backbone } = require('../helpers/backbone');

const Backbone = backbone('1.4.0');
const METHODS = [
	{ name: 'getThings', get: 'things', cache: true },
	{ name: 'addThing', post: 'things', idempotent: true },
	{ name: 'removeThing', delete: 'things/<id>', retry: true }
];

let ti;
afterEach(() => ti && ti.uninstall());

function make(config) {
	const made = setup(Object.assign({ Backbone, methods: METHODS, retry: true }, config));
	ti = made.ti;
	ti.respond(() => ({ status: 200, body: { data: [{ id: 1 }] } }));
	return made;
}

/** True when the code of the data layer has been loaded into this process at all (not just used by an instance). */
function dataCodeLoaded() {
	return Object.keys(require.cache).some(file => /[\\/]src[\\/](sync|merge|list|identity|pagination)\.js$/.test(file) || /reste\.data\.js$/.test(file));
}

// The single file holds everything, so there only the instance can say what it has set up.
const separate = !/[\\/]reste\.js$/.test(Reste.entry) || /[\\/]split[\\/]/.test(Reste.entry);

describe('loading', () => {
	// First in this file on purpose: nothing before it may have touched the data layer.
	it('configures, sends, caches, retries and resets sessions without the data layer', async () => {
		const { api } = make({ onStatus: { 401: () => {} }, interceptors: { request: () => {} } });
		await api.getThings();
		await api.getThings();
		await api.addThing({ body: { name: 'x' } }, { action: 'add' });
		await api.removeThing({ id: 1 });
		api.session.reset();
		api.cache.clear();
		assert.equal(api.inspect().loaded.data, false);
		assert.deepEqual(api.inspect().identity, {});
		if (separate) {
			assert.equal(dataCodeLoaded(), false, 'the code of models, collections and lists was not even loaded');
		}
	});

	it('replaces the attributes of a model the app made itself without it', () => {
		const { api } = make();
		const model = new Backbone.Model({ id: 1, stale: true, name: 'a' });
		assert.equal(api.replace(model, { id: 1, name: 'b' }), model);
		assert.deepEqual(model.toJSON(), { id: 1, name: 'b' });
		assert.equal(api.inspect().loaded.data, false);
		if (separate) {
			assert.equal(dataCodeLoaded(), false);
		}
	});

	it('loads it on first use: a merge, a list, an optimistic write, a pager, a model definition, collections', () => {
		const uses = {
			upsert: api => api.upsert(new Backbone.Collection(), [{ id: 1 }]),
			list: api => api.list({ collection: new Backbone.Collection(), load: () => Promise.resolve([]) }),
			optimistic: api => api.optimistic(new Backbone.Model({ id: 1 }), { a: 1 }, () => Promise.resolve()),
			paginate: api => api.paginate('getThings', { paginate: 'page' }),
			addModel: api => api.addModel({ name: 'thing', collections: [{ name: 'things', read: 'getThings' }] }),
			collections: api => api.collections,
			identity: api => api.identity.sizes(),
			createModel: api => api.createModel('anything', { id: 1 })
		};
		Object.keys(uses).forEach((name) => {
			const { api } = make();
			assert.equal(api.inspect().loaded.data, false, name);
			uses[name](api);
			assert.equal(api.inspect().loaded.data, true, name);
			ti.uninstall();
		});
		assert.equal(dataCodeLoaded() || !separate, true);
	});

	it('a pager or a models config loads it when it is needed, and preload() ahead of time', async () => {
		const paged = make({ methods: [{ name: 'getPage', get: 'things', paginate: 'page' }] });
		assert.deepEqual(await paged.api.getPage(), { data: [{ id: 1 }] });
		assert.equal(paged.api.inspect().loaded.data, false); // called like any method: no pager is involved
		assert.equal(typeof paged.api.paginate('getPage').next, 'function');
		assert.equal(paged.api.inspect().loaded.data, true);
		ti.uninstall();
		const modelled = make({ models: [{ name: 'thing', collections: [{ name: 'things', read: 'getThings' }] }] });
		assert.equal(modelled.api.inspect().loaded.data, true);
		ti.uninstall();
		const idle = make();
		assert.equal(idle.api.preload(), idle.api);
		assert.equal(idle.api.inspect().loaded.data, true);
	});
});
