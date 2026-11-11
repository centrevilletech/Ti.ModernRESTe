'use strict';

/* Models and collections, on every Backbone version Alloy can be configured with. */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rejection } = require('../helpers/setup');
const { eachBackbone, installAlloy, uninstallAlloy, record } = require('../helpers/backbone');

const METHODS = [
	{ name: 'getLocations', get: 'locations' },
	{ name: 'getLocationsByName', get: 'locations?name=<name>' },
	{ name: 'getLocation', get: 'locations/<id>' },
	{ name: 'createLocation', post: 'locations' },
	{ name: 'updateLocation', put: 'locations/<id>' },
	{ name: 'patchLocation', patch: 'locations/<id>' },
	{ name: 'deleteLocation', delete: 'locations/<id>' }
];

function locationModel(extra) {
	return Object.assign({
		name: 'location',
		id: 'objectId',
		read: 'getLocation',
		create: 'createLocation',
		update: 'updateLocation',
		patch: 'patchLocation',
		delete: 'deleteLocation',
		collections: [
			{ name: 'locations', content: 'results', read: 'getLocations' },
			{ name: 'locationsByName', content: 'results', read: 'getLocationsByName' }
		]
	}, extra);
}

const LIST = { results: [{ objectId: 'a1', name: 'Home' }, { objectId: 'b2', name: 'Work' }] };

eachBackbone((Backbone, version) => {
	const legacy = version === '0.9.2';

	describe('models and collections on Backbone ' + version, () => {
		let ti;
		let originalSync;

		beforeEach(() => {
			installAlloy(Backbone);
			originalSync = Backbone.sync;
		});
		afterEach(() => {
			assert.equal(Backbone.sync, originalSync, 'Backbone.sync must never be replaced');
			uninstallAlloy();
			if (ti) {
				ti.uninstall();
			}
		});

		function make(config) {
			const made = setup(Object.assign({ methods: METHODS, models: [locationModel()] }, config));
			ti = made.ti;
			ti.respond(() => ({ status: 200, body: LIST }));
			return made;
		}

		it('leaves Backbone.sync alone: other models and collections keep their own sync', async () => {
			let globalCalls = 0;
			const untouched = Backbone.sync;
			Backbone.sync = function (method, model, options) {
				globalCalls++;
				options.success(model instanceof Backbone.Collection ? [{ id: 1 }] : { id: 1 });
			};
			originalSync = Backbone.sync;
			try {
				make();
				const Plain = Backbone.Collection.extend({ url: '/plain' });
				const plain = new Plain();
				plain.fetch();
				assert.equal(globalCalls, 1);
				assert.equal(plain.length, 1);
				await Alloy.Collections.locations.fetch();
				assert.equal(globalCalls, 1);
				assert.equal(ti.requests.length, 1);
			} finally {
				Backbone.sync = untouched;
				originalSync = untouched;
			}
		});

		it('two instances with models do not break each other', async () => {
			// Upstream: the second instance's Backbone.sync replaced the first one's.
			const first = make();
			const second = new first.Reste();
			second.config({
				url: 'https://second.test/',
				methods: [{ name: 'getUsers', get: 'users' }],
				models: [{ name: 'user', id: 'id', collections: [{ name: 'users', read: 'getUsers' }] }]
			});
			ti.respond(request => ({ status: 200, body: request.url.indexOf('second') !== -1 ? [{ id: 1 }] : LIST }));
			await Alloy.Collections.locations.fetch();
			await Alloy.Collections.users.fetch();
			await Alloy.Collections.locations.fetch();
			assert.equal(Alloy.Collections.locations.length, 2);
			assert.equal(Alloy.Collections.users.length, 1);
		});

		it('creates Alloy.Collections and adopts a collection that already exists', () => {
			const existing = new Backbone.Collection();
			Alloy.Collections.locations = existing;
			const { api } = make();
			assert.equal(Alloy.Collections.locations, existing);
			assert.ok(Alloy.Collections.locationsByName instanceof Backbone.Collection);
			assert.equal(api.collections.locations, existing);
			assert.equal(existing._type, 'location');
			assert.equal(existing._name, 'locations');
		});

		it('fetch() fills the collection from `content` and fires sync once', async () => {
			make();
			const collection = Alloy.Collections.locations;
			const events = record(collection);
			const succeeded = [];
			const result = await collection.fetch({ success: (target, response) => succeeded.push([target, response]) });
			assert.equal(result, collection);
			assert.deepEqual(collection.pluck('name'), ['Home', 'Work']);
			assert.equal(events.count('sync'), 1); // upstream fired it twice on Backbone 1.x
			assert.equal(succeeded.length, 1);
			assert.equal(succeeded[0][0], collection);
			assert.ok(collection.at(0) instanceof collection.model);
			assert.equal(collection.at(0)._type, 'location');
		});

		it('accepts a bare array when the response has no `content` key', async () => {
			make();
			ti.respond(() => ({ status: 200, body: [{ objectId: 'z', name: 'Bare' }] }));
			await Alloy.Collections.locations.fetch();
			assert.deepEqual(Alloy.Collections.locations.pluck('name'), ['Bare']);
		});

		it('fetch({ name }) fills URL placeholders, as upstream', async () => {
			make();
			await Alloy.Collections.locationsByName.fetch({ name: 'home sweet' });
			assert.equal(ti.last.url, 'https://api.test/v1/locations?name=home%20sweet');
		});

		it('fetch() passes query, headers and timeout through', async () => {
			make();
			await Alloy.Collections.locations.fetch({ query: { near: '1,2' }, headers: { 'X-Trace': 't' }, timeout: 4321 });
			assert.equal(ti.last.url, 'https://api.test/v1/locations?near=1%2C2');
			assert.equal(ti.last.headers['X-Trace'], 't');
			assert.equal(ti.clients[0].creation.timeout, 4321);
		});

		it('fetch() reports failures to the error callback and the error event', async () => {
			make();
			ti.respond(() => ({ status: 500, body: { message: 'down' } }));
			const collection = Alloy.Collections.locations;
			const events = record(collection);
			const failures = [];
			const handle = collection.fetch({ error: (target, error) => failures.push([target, error]) });
			const error = await rejection(handle);
			assert.equal(error.status, 500);
			assert.equal(failures.length, 1);
			assert.equal(failures[0][0], collection);
			assert.equal(failures[0][1].status, 500);
			events.clear();
			await rejection(collection.fetch());
			assert.equal(events.count('error'), 1);
		});

		it('fetch() fails cleanly when the response holds no list', async () => {
			// Upstream: "response.forEach is not a function".
			make();
			ti.respond(() => ({ status: 200, body: { unexpected: true } }));
			const error = await rejection(Alloy.Collections.locations.fetch());
			assert.equal(error.kind, 'parse');
		});

		it('fetch() fails cleanly when the read method does not exist', async () => {
			// Upstream: "undefined is not an object (evaluating 'collectionConfig.read')".
			make({ models: [{ name: 'ghost', collections: [{ name: 'ghosts', read: 'nope' }, { name: 'unread' }] }] });
			assert.equal((await rejection(Alloy.Collections.ghosts.fetch())).kind, 'config');
			assert.equal((await rejection(Alloy.Collections.unread.fetch())).kind, 'config');
		});

		it('uses the configured id attribute and mirrors it to `id`, as upstream did', async () => {
			make();
			const collection = Alloy.Collections.locations;
			await collection.fetch();
			const model = collection.get('a1');
			assert.equal(model.id, 'a1');
			assert.equal(model.idAttribute, 'objectId');
			assert.equal(model.get('id'), 'a1');
			assert.equal(model.get('objectId'), 'a1');
		});

		it('can stop mirroring the id', async () => {
			make({ models: [locationModel({ mirrorId: false })] });
			await Alloy.Collections.locations.fetch();
			assert.equal(Alloy.Collections.locations.get('a1').has('id'), false);
		});

		it('does not overwrite `id` when a model has no id configured', async () => {
			// Upstream set item.id = item[undefined].
			make({ models: [{ name: 'plain', collections: [{ name: 'plains', read: 'getLocations', content: 'results' }] }] });
			ti.respond(() => ({ status: 200, body: { results: [{ id: 5, name: 'Five' }] } }));
			await Alloy.Collections.plains.fetch();
			assert.equal(Alloy.Collections.plains.at(0).id, 5);
			assert.equal(Alloy.Collections.plains.get(5).get('name'), 'Five');
		});

		it('create: POSTs the attributes, takes the id from the response, runs beforeCreate', async () => {
			const hooks = [];
			const { api } = make({
				models: [locationModel({
					beforeCreate(body) {
						hooks.push('create');
						return Object.assign({ stamped: true }, body);
					},
					beforeDelete() {
						hooks.push('delete'); // upstream called this one on create
					}
				})]
			});
			ti.respond(() => ({ status: 201, body: { objectId: 'n1', createdAt: 'now' } }));
			const model = api.createModel('location');
			const saved = [];
			await model.save({ name: 'New' }, { success: target => saved.push(target) });
			assert.equal(ti.last.method, 'POST');
			assert.equal(ti.last.url, 'https://api.test/v1/locations');
			assert.deepEqual(ti.last.json, { stamped: true, name: 'New' });
			assert.equal(model.id, 'n1');
			assert.equal(model.get('createdAt'), 'now');
			assert.equal(model.isNew(), false);
			assert.deepEqual(hooks, ['create']);
			assert.equal(saved[0], model);
		});

		it('update: PUTs to the id, whether the URL says <id> or <objectId>', async () => {
			const { api } = make({
				methods: METHODS.concat([{ name: 'updateByObjectId', put: 'things/<objectId>' }]),
				models: [locationModel(), { name: 'thing', id: 'objectId', update: 'updateByObjectId' }]
			});
			ti.respond(() => ({ status: 200, body: {} }));
			await api.createModel('location', { objectId: 'a1', name: 'Home' }).save({ name: 'House' });
			assert.equal(ti.last.method, 'PUT');
			assert.equal(ti.last.url, 'https://api.test/v1/locations/a1'); // upstream sent "locations/<id>" literally
			assert.equal(ti.last.json.name, 'House');
			assert.equal(ti.last.json.objectId, undefined);
			assert.equal(ti.last.json.id, undefined);
			await api.createModel('thing', { objectId: 't9', n: 1 }).save({ n: 2 });
			assert.equal(ti.last.url, 'https://api.test/v1/things/t9');
		});

		it('update: beforeUpdate can reshape the body', async () => {
			const { api } = make({ models: [locationModel({ beforeUpdate: body => ({ location: body }) })] });
			ti.respond(() => ({ status: 200, body: {} }));
			await api.createModel('location', { objectId: 'a1', name: 'Home' }).save({ name: 'House' });
			assert.deepEqual(Object.keys(ti.last.json), ['location']);
		});

		it('save(attrs, { patch: true }) PATCHes only those attributes', async () => {
			const { api } = make();
			ti.respond(() => ({ status: 200, body: {} }));
			const model = api.createModel('location', { objectId: 'a1', name: 'Home', city: 'X' });
			await model.save({ name: 'House' }, { patch: true });
			assert.equal(ti.last.method, 'PATCH');
			assert.equal(ti.last.url, 'https://api.test/v1/locations/a1');
			assert.deepEqual(ti.last.json, { name: 'House' });
		});

		it('patch falls back to the update method when the model has no patch method', async () => {
			const { api } = make({ models: [locationModel({ patch: undefined })] });
			ti.respond(() => ({ status: 200, body: {} }));
			await api.createModel('location', { objectId: 'a1', name: 'Home' }).save({ name: 'House' }, { patch: true });
			assert.equal(ti.last.method, 'PUT');
		});

		it('delete: DELETEs the id without a body, unless beforeDelete provides one', async () => {
			let made = make();
			ti.respond(() => ({ status: 204 }));
			const collection = Alloy.Collections.locations;
			collection.reset([{ objectId: 'a1', name: 'Home' }]);
			const model = collection.at(0);
			await model.destroy();
			assert.equal(ti.last.method, 'DELETE');
			assert.equal(ti.last.url, 'https://api.test/v1/locations/a1');
			assert.equal(ti.last.body, undefined);
			assert.equal(collection.length, 0);
			uninstallAlloy();
			ti.uninstall();
			installAlloy(Backbone);
			made = make({ models: [locationModel({ beforeDelete: body => ({ reason: 'cleanup', name: body.name }) })] });
			ti.respond(() => ({ status: 204 }));
			await made.api.createModel('location', { objectId: 'a1', name: 'Home' }).destroy();
			assert.deepEqual(ti.last.json, { reason: 'cleanup', name: 'Home' });
		});

		it('read: fetches by id and takes the model from `content`, an array of one, or the body', async () => {
			const { api } = make({ models: [locationModel({ content: 'result' })] });
			const model = api.createModel('location', { objectId: 'a1' });
			ti.respond(() => ({ status: 200, body: { result: { objectId: 'a1', name: 'From content' } } }));
			await model.fetch();
			assert.equal(ti.last.url, 'https://api.test/v1/locations/a1');
			assert.equal(model.get('name'), 'From content');
			ti.respond(() => ({ status: 200, body: { result: [{ objectId: 'a1', name: 'From array' }] } }));
			await model.fetch();
			assert.equal(model.get('name'), 'From array');
			ti.respond(() => ({ status: 200, body: { objectId: 'a1', name: 'From body' } }));
			await model.fetch(); // upstream: TypeError when `content` was configured but absent
			assert.equal(model.get('name'), 'From body');
		});

		it('does not mistake a `code` field in a successful response for an error', async () => {
			// Upstream: `if (e.code > 200) onError(e)`.
			const { api } = make();
			ti.respond(() => ({ status: 200, body: { objectId: 'a1', code: 9000, name: 'Zip' } }));
			const model = api.createModel('location', { objectId: 'a1' });
			const failures = [];
			await model.fetch({ error: () => failures.push(1) });
			assert.equal(model.get('code'), 9000);
			assert.deepEqual(failures, []);
		});

		it('save and destroy report failures to the error callback', async () => {
			const { api } = make();
			ti.respond(() => ({ status: 422, body: { errors: { name: ['taken'] } } }));
			const model = api.createModel('location', { objectId: 'a1', name: 'Home' });
			const failures = [];
			const error = await rejection(model.save({ name: 'Work' }, { error: (target, failure) => failures.push([target, failure]) }));
			assert.equal(error.status, 422);
			assert.equal(failures[0][0], model);
			assert.deepEqual(failures[0][1].body, { errors: { name: ['taken'] } });
			await rejection(model.destroy({ error: (target, failure) => failures.push([target, failure]) }));
			assert.equal(failures.length, 2);
		});

		it('fails cleanly when a model has no method for an operation', async () => {
			// Upstream: "reste[undefined] is not a function".
			const { api } = make({ models: [{ name: 'readonly', id: 'id', read: 'getLocation' }] });
			const model = api.createModel('readonly', { id: 1 });
			const failures = [];
			const error = await rejection(model.save({ a: 1 }, { error: (target, failure) => failures.push(failure) }));
			assert.equal(error.kind, 'config');
			assert.match(error.message, /has no update method/);
			assert.equal(failures.length, 1);
			assert.equal(ti.requests.length, 0);
		});

		it('fills nested-resource placeholders from the model, or from options.params', async () => {
			const { api } = make({
				methods: [{ name: 'getOffer', get: 'jobs/<jobId>/offers/<id>' }, { name: 'updateOffer', put: 'jobs/<jobId>/offers/<id>' }],
				models: [{ name: 'offer', id: 'id', read: 'getOffer', update: 'updateOffer' }]
			});
			ti.respond(() => ({ status: 200, body: {} }));
			const model = api.createModel('offer', { id: 3, jobId: 'j7', price: 10 });
			await model.fetch();
			assert.equal(ti.last.url, 'https://api.test/v1/jobs/j7/offers/3');
			await model.save({ price: 12 }, { params: { jobId: 'other' } });
			assert.equal(ti.last.url, 'https://api.test/v1/jobs/other/offers/3');
		});

		it('createModel gives typed models with transform(), and plain ones for unknown names', async () => {
			const { api } = make({ models: [locationModel({ transform: model => ({ title: model.get('name').toUpperCase() }) })] });
			const model = api.createModel('location', { objectId: 'a1', name: 'home' });
			assert.deepEqual(model.transform(), { title: 'HOME' });
			assert.deepEqual(model.transform(model, target => ({ local: target.get('name') })), { local: 'home' });
			assert.deepEqual(model.__transform, { local: 'home' });
			const plain = api.createModel('whatever', { a: 1 });
			assert.deepEqual(plain.transform(), { a: 1 });
			assert.equal(plain._type, 'whatever');
		});

		it('collection models transform for Alloy data binding', async () => {
			make({ models: [locationModel({ transform: model => ({ label: model.get('name') + '!' }) })] });
			await Alloy.Collections.locations.fetch();
			assert.deepEqual(Alloy.Collections.locations.map(model => model.transform()), [{ label: 'Home!' }, { label: 'Work!' }]);
		});

		it('createCollection wraps an array for binding, as upstream', () => {
			const { api } = make();
			const collection = api.createCollection('adhoc', [{ id: 1 }, { id: 2 }]);
			assert.equal(Alloy.Collections.adhoc, collection);
			assert.equal(collection.length, 2);
			const events = record(collection);
			collection.fetch();
			assert.equal(events.count('change'), 1);
			assert.throws(() => api.createCollection('bad', 'nope'), /No Array specified/);
		});

		it('keeps singleton models in Alloy.Models', async () => {
			const { api } = make({
				methods: [{ name: 'getMe', get: 'me' }, { name: 'updateMe', patch: 'me' }],
				models: [{ name: 'me', singleton: true, read: 'getMe', update: 'updateMe', content: 'data' }]
			});
			ti.respond(() => ({ status: 200, body: { data: { id: 7, name: 'Ada', plan: 'pro' } } }));
			assert.equal(Alloy.Models.me, api.models.me);
			await Alloy.Models.me.fetch();
			assert.equal(Alloy.Models.me.get('name'), 'Ada');
			Alloy.Models.me.replace({ id: 7, name: 'Ada L.' });
			assert.deepEqual(Alloy.Models.me.toJSON(), { id: 7, name: 'Ada L.' });
		});

		it('drops a list that arrives after the session ended', async () => {
			const { api } = make();
			ti.respond(() => null);
			const collection = Alloy.Collections.locations;
			collection.reset([{ objectId: 'mine', name: 'New user\'s' }]);
			const handle = collection.fetch();
			api.session.reset({ abort: false });
			ti.requests[0].respond({ status: 200, body: LIST });
			assert.equal((await rejection(handle)).kind, 'stale');
			assert.deepEqual(collection.pluck('name'), ['New user\'s']);
		});

		it('session.reset({ resetCollections }) empties collections and singleton models', async () => {
			const { api } = make({ models: [locationModel(), { name: 'me', singleton: true }] });
			await Alloy.Collections.locations.fetch();
			api.models.me.set({ name: 'x' });
			api.session.reset({ resetCollections: true });
			assert.equal(Alloy.Collections.locations.length, 0);
			assert.deepEqual(api.models.me.toJSON(), {});
		});

		it('a paginated collection keeps the paging metadata on a plain fetch()', async () => {
			make({
				methods: [{ name: 'getItems', get: 'items', paginate: { style: 'page', perPage: 2 } }],
				models: [{ name: 'item', collections: [{ name: 'items', read: 'getItems', content: 'data' }] }]
			});
			ti.respond(request => ({ status: 200, body: { data: [{ id: 1 }, { id: 2 }], meta: { current_page: 1, last_page: 3, total: 6, echo: request.url } } }));
			const collection = Alloy.Collections.items;
			await collection.fetch();
			assert.equal(ti.last.url, 'https://api.test/v1/items?page=1&per_page=2');
			assert.equal(collection.meta, null); // no `meta` path configured for this API
			assert.deepEqual(collection.paging, { style: 'page', page: 1, lastPage: null, total: null, hasMore: true, hasPrevious: false, nextCursor: null });
			assert.equal(collection.hasMore(), true);
		});

		if (legacy) {
			it('Backbone 0.9.2: update sends what the save changed, as upstream', async () => {
				const { api } = make();
				ti.respond(() => ({ status: 200, body: {} }));
				const model = api.createModel('location', { objectId: 'a1', name: 'Home', city: 'X' });
				await model.save({ name: 'House' });
				assert.deepEqual(ti.last.json, { name: 'House' });
				await model.save(); // upstream sent {} here
				assert.deepEqual(ti.last.json, { name: 'House', city: 'X' });
			});
		}
	});
});
