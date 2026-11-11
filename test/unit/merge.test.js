'use strict';

/* Lists merged in place, identity across collections, optimistic updates: on every Backbone version. */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rejection, wait } = require('../helpers/setup');
const { eachBackbone, installAlloy, uninstallAlloy, record } = require('../helpers/backbone');

function items(from, to, extra) {
	const out = [];
	for (let id = from; id <= to; id++) {
		out.push(Object.assign({ id, title: 'Item ' + id, tags: ['t' + (id % 3)], owner: { id: id % 5 } }, extra));
	}
	return out;
}

const METHODS = [
	{ name: 'getJobs', get: 'jobs', paginate: { style: 'page', perPage: 10 } },
	{ name: 'getMyJobs', get: 'me/jobs' },
	{ name: 'getJob', get: 'jobs/<id>' },
	{ name: 'createJob', post: 'jobs' },
	{ name: 'updateJob', put: 'jobs/<id>' },
	{ name: 'patchJob', patch: 'jobs/<id>' },
	{ name: 'deleteJob', delete: 'jobs/<id>' },
	{ name: 'getMessages', get: 'messages', paginate: { style: 'cursor', limit: 5 } }
];

function models(extra, collectionExtra) {
	return [
		Object.assign({
			name: 'job',
			read: 'getJob',
			create: 'createJob',
			update: 'updateJob',
			patch: 'patchJob',
			delete: 'deleteJob',
			content: 'data',
			collections: [
				Object.assign({ name: 'jobs', read: 'getJobs', content: 'data', merge: true }, collectionExtra),
				{ name: 'myJobs', read: 'getMyJobs', content: 'data', merge: true }
			]
		}, extra),
		{ name: 'message', collections: [{ name: 'messages', read: 'getMessages', content: 'data', merge: true }] }
	];
}

/** What an Alloy view bound with dataCollection listens to: every one of these events re-renders the list. */
function bind(collection, version) {
	const events = version === '0.9.2' ? 'fetch destroy change add remove reset' : 'fetch destroy change add remove reset sort';
	const binding = { renders: 0 };
	collection.on(events, () => binding.renders++);
	return binding;
}

eachBackbone((Backbone, version) => {
	describe('merging lists on Backbone ' + version, () => {
		let ti;
		let served;

		beforeEach(() => installAlloy(Backbone));
		afterEach(() => {
			uninstallAlloy();
			if (ti) {
				ti.uninstall();
			}
		});

		function make(config, modelExtra, collectionExtra) {
			const made = setup(Object.assign({ meta: 'meta', methods: METHODS, models: models(modelExtra, collectionExtra) }, config));
			ti = made.ti;
			served = { data: items(1, 10), meta: { current_page: 1, last_page: 3, total: 25 } };
			ti.respond((request) => {
				const page = Number(new URL(request.url).searchParams.get('page') || 1);
				if (request.url.indexOf('/jobs?') !== -1 && page > 1) {
					return { status: 200, body: { data: items((page - 1) * 10 + 1, Math.min(page * 10, 25)), meta: { current_page: page, last_page: 3, total: 25 } } };
				}
				return { status: 200, body: served };
			});
			return made;
		}

		it('a refresh keeps the model instances and changes only what changed', async () => {
			make();
			const jobs = Alloy.Collections.jobs;
			await jobs.fetch();
			const before = jobs.models.slice();
			const third = jobs.get(3);
			const changes = [];
			third.on('all', name => changes.push(name));
			const untouched = record(jobs.get(4));
			served = { data: items(1, 10).map(item => (item.id === 3 ? Object.assign({}, item, { title: 'Renamed' }) : item)), meta: served.meta };
			const result = await jobs.fetch();
			assert.deepEqual(jobs.models, before); // the very same instances, same order
			assert.equal(third.get('title'), 'Renamed');
			assert.deepEqual(changes, ['change:title', 'change']);
			assert.deepEqual(untouched.names, []);
			assert.deepEqual([result.added.length, result.changed.length, result.removed.length], [0, 1, 0]);
			assert.equal(result.changed[0], third);
		});

		it('renders a bound list once per merge, however many rows changed', async () => {
			make();
			const jobs = Alloy.Collections.jobs;
			const binding = bind(jobs, version);
			await jobs.fetch();
			assert.equal(binding.renders, 1);
			served = { data: items(1, 10, { title: 'All renamed' }).concat(items(11, 12)), meta: served.meta };
			await jobs.fetch();
			assert.equal(binding.renders, 2); // ten changes and two additions: one render
			assert.equal(jobs.length, 12);
		});

		it('fires nothing and renders nothing when the data did not change', async () => {
			make({}, {}, { skipUnchanged: false });
			const jobs = Alloy.Collections.jobs;
			await jobs.fetch();
			const binding = bind(jobs, version);
			const events = record(jobs);
			const result = await jobs.fetch();
			assert.equal(binding.renders, 0);
			assert.deepEqual(events.names, ['request', 'sync']);
			assert.equal(result.touched, false);
		});

		it('does not even parse a refresh that returns the same bytes', async () => {
			make();
			const jobs = Alloy.Collections.jobs;
			await jobs.fetch();
			const original = JSON.parse;
			let parses = 0;
			JSON.parse = function () {
				parses++;
				return original.apply(this, arguments);
			};
			let result;
			try {
				result = await jobs.fetch();
			} finally {
				JSON.parse = original;
			}
			assert.equal(parses, 0);
			assert.equal(result.unchanged, true);
			assert.equal(jobs.length, 10);
			// Once something touched the collection the shortcut is off: the server's list wins again.
			jobs.get(2).set({ title: 'Edited locally' });
			const again = await jobs.fetch();
			assert.equal(again.unchanged, undefined);
			assert.equal(jobs.get(2).get('title'), 'Item 2');
		});

		it('a refresh removes what is gone, adds what is new and follows the server\'s order', async () => {
			make();
			const jobs = Alloy.Collections.jobs;
			await jobs.fetch();
			const kept = jobs.get(5);
			served = { data: [items(12, 12)[0], items(5, 5)[0], items(1, 1)[0]], meta: served.meta };
			const result = await jobs.fetch();
			assert.deepEqual(jobs.pluck('id'), [12, 5, 1]);
			assert.equal(jobs.get(5), kept);
			assert.deepEqual([result.added.length, result.removed.length], [1, 8]);
			assert.equal(jobs.get(2), undefined);
		});

		it('a collection with a comparator stays sorted and is not rebuilt for nothing', async () => {
			make();
			const jobs = Alloy.Collections.jobs;
			jobs.comparator = model => -model.get('id');
			await jobs.fetch();
			assert.deepEqual(jobs.pluck('id').slice(0, 3), [10, 9, 8]);
			const binding = bind(jobs, version);
			await jobs.fetch({ skipUnchanged: false });
			assert.equal(binding.renders, 0);
		});

		it('fetchNext() appends pages and keeps what is loaded; hasMore() and paging follow the server', async () => {
			make();
			const jobs = Alloy.Collections.jobs;
			await jobs.fetch();
			assert.deepEqual(jobs.paging, { style: 'page', page: 1, lastPage: 3, total: 25, hasMore: true, hasPrevious: false, nextCursor: null });
			assert.deepEqual(jobs.meta, { current_page: 1, last_page: 3, total: 25 });
			const first = jobs.at(0);
			const binding = bind(jobs, version);
			const page = await jobs.fetchNext();
			assert.equal(ti.last.url, 'https://api.test/v1/jobs?page=2&per_page=10');
			assert.equal(page.added.length, 10);
			assert.equal(jobs.length, 20);
			assert.equal(jobs.at(0), first);
			assert.equal(binding.renders, 1);
			await jobs.fetchNext();
			assert.equal(jobs.length, 25);
			assert.equal(jobs.hasMore(), false);
			const end = await jobs.fetchNext();
			assert.equal(end.done, true);
			assert.equal(ti.requests.length, 3);
		});

		it('refresh() after more pages goes back to the first page', async () => {
			make();
			const jobs = Alloy.Collections.jobs;
			await jobs.fetch();
			await jobs.fetchNext();
			assert.equal(jobs.length, 20);
			await jobs.refresh();
			assert.equal(jobs.length, 10);
			assert.equal(jobs.paging.page, 1);
			assert.equal(jobs.hasMore(), true);
		});

		it('cursor lists prepend older items and append newer ones, in order', async () => {
			make();
			const all = items(1, 12);
			ti.respond((request) => {
				const query = new URL(request.url).searchParams;
				if (query.get('after')) {
					return { status: 200, body: { data: all.filter(item => item.id > Number(query.get('after'))), meta: { has_more: false } } };
				}
				const older = query.get('before') ? all.filter(item => item.id < Number(query.get('before'))) : all;
				return { status: 200, body: { data: older.slice(-5), meta: { has_more: older.length > 5 } } };
			});
			const messages = Alloy.Collections.messages;
			await messages.fetch();
			assert.deepEqual(messages.pluck('id'), [8, 9, 10, 11, 12]);
			const newest = messages.get(12);
			await messages.fetchNext();
			assert.equal(new URL(ti.last.url).searchParams.get('before'), '8');
			assert.deepEqual(messages.pluck('id'), [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
			assert.equal(messages.get(12), newest);
			await messages.fetchNext();
			assert.equal(messages.hasMore(), false);
			assert.equal(messages.length, 12);
			all.push({ id: 13, title: 'New' });
			await messages.fetchPrevious();
			assert.equal(new URL(ti.last.url).searchParams.get('after'), '12');
			assert.equal(messages.at(messages.length - 1).id, 13);
		});

		it('upsert() merges items from anywhere: a socket message, a push payload', () => {
			make();
			const jobs = Alloy.Collections.jobs;
			jobs.reset(items(1, 3));
			const binding = bind(jobs, version);
			const second = jobs.get(2);
			const result = jobs.upsert([{ id: 2, title: 'Updated by socket' }, { id: 9, title: 'Brand new' }], { position: 'start' });
			assert.equal(jobs.get(2), second);
			assert.equal(second.get('title'), 'Updated by socket');
			assert.deepEqual(second.get('tags'), ['t2']); // fields the payload lacks are kept
			assert.deepEqual(jobs.pluck('id'), [9, 1, 2, 3]);
			assert.deepEqual([result.added.length, result.changed.length], [1, 1]);
			assert.equal(binding.renders, 1);
			jobs.upsert({ id: 9, title: 'Brand new' });
			assert.equal(binding.renders, 1);
		});

		it('folds duplicate ids in one response into one model', async () => {
			make();
			served = { data: [{ id: 1, title: 'a' }, { id: 1, title: 'b' }, { id: 2, title: 'c' }], meta: null };
			const jobs = Alloy.Collections.jobs;
			await jobs.fetch();
			assert.deepEqual(jobs.pluck('id'), [1, 2]);
			assert.equal(jobs.get(1).get('title'), 'b');
		});

		it('events: "each" keeps Backbone\'s per-model events for code that wants them', async () => {
			make();
			const jobs = Alloy.Collections.jobs;
			const events = record(jobs);
			await jobs.fetch({ events: 'each' });
			assert.equal(events.count('add'), 10);
			assert.equal(events.count('fetch'), 0);
		});

		it('merges a large list in chunks across event-loop turns, with one render at the end', async () => {
			make({ chunk: 100 });
			served = { data: items(1, 500), meta: null };
			const jobs = Alloy.Collections.jobs;
			const binding = bind(jobs, version);
			let turns = 0;
			const ticker = setInterval(() => turns++, 0);
			const result = await jobs.fetch();
			clearInterval(ticker);
			assert.equal(jobs.length, 500);
			assert.equal(result.added.length, 500);
			assert.ok(turns >= 3, 'other work ran between chunks (' + turns + ' turns)');
			assert.equal(binding.renders, 1);
			assert.deepEqual(jobs.pluck('id').slice(0, 3), [1, 2, 3]);
		});

		it('stops a chunked merge when the session ends half-way', async () => {
			const { api } = make({ chunk: 50 });
			served = { data: items(1, 400), meta: null };
			const jobs = Alloy.Collections.jobs;
			const handle = jobs.fetch();
			await wait(0);
			while (jobs.length === 0 && ti.requests.length === 0) {
				await wait(1);
			}
			await wait(2);
			api.session.reset({ resetCollections: true });
			const error = await rejection(handle);
			assert.equal(error.kind, 'stale');
			assert.equal(jobs.length, 0);
		});

		it('fetch({ reset: true }) and merge: false still use Backbone\'s own fetch', async () => {
			make();
			const jobs = Alloy.Collections.jobs;
			await jobs.fetch();
			const first = jobs.at(0);
			const events = record(jobs);
			await jobs.fetch({ reset: true });
			assert.notEqual(jobs.at(0), first);
			assert.equal(events.count('reset'), 1);
			await jobs.fetch({ merge: false });
			assert.equal(jobs.length, 10);
		});

		it('reports merge failures to the error callback and the error event', async () => {
			make();
			ti.respond(() => ({ status: 503 }));
			const jobs = Alloy.Collections.jobs;
			const events = record(jobs);
			const failures = [];
			const error = await rejection(jobs.fetch({ error: (target, failure) => failures.push([target, failure.status]) }));
			assert.equal(error.status, 503);
			assert.deepEqual(failures, [[jobs, 503]]);
			assert.equal(events.count('error'), 1);
			assert.equal((await rejection(Alloy.Collections.myJobs.fetchNext())).kind, 'config');
		});

		it('abort() on a merge fetch cancels the request', async () => {
			make();
			ti.respond(() => null);
			const handle = Alloy.Collections.jobs.fetch();
			handle.abort();
			assert.equal(ti.last.aborted, true);
			assert.equal((await rejection(handle)).kind, 'cancelled');
		});

		it('serves a refresh from a 304 without merging', async () => {
			make({ methods: METHODS.map(method => (method.name === 'getMyJobs' ? Object.assign({ cache: 'etag' }, method) : method)) });
			ti.respond(request => (request.headers['If-None-Match'] === '"v1"' ? { status: 304 } : { status: 200, body: { data: items(1, 5) }, headers: { ETag: '"v1"' } }));
			const mine = Alloy.Collections.myJobs;
			await mine.fetch();
			const binding = bind(mine, version);
			const result = await mine.fetch();
			assert.equal(ti.requests.length, 2);
			assert.equal(result.unchanged, true);
			assert.equal(binding.renders, 0);
			assert.equal(mine.length, 5);
		});
	});

	describe('one model per id on Backbone ' + version, () => {
		let ti;

		beforeEach(() => installAlloy(Backbone));
		afterEach(() => {
			uninstallAlloy();
			if (ti) {
				ti.uninstall();
			}
		});

		function make(config) {
			const made = setup(Object.assign({ identity: true, methods: METHODS, models: models() }, config));
			ti = made.ti;
			return made;
		}

		it('shares one instance between collections, so every list follows a change', async () => {
			make();
			ti.respond(request => ({ status: 200, body: { data: request.url.indexOf('me/jobs') !== -1 ? items(3, 4) : items(1, 5) } }));
			const jobs = Alloy.Collections.jobs;
			const mine = Alloy.Collections.myJobs;
			await jobs.fetch();
			await mine.fetch();
			assert.equal(mine.get(3), jobs.get(3));
			const mineBinding = bind(mine, version);
			ti.respond(() => ({ status: 200, body: { data: items(1, 5).map(item => (item.id === 3 ? Object.assign(item, { title: 'Changed' }) : item)) } }));
			await jobs.fetch();
			assert.equal(mine.get(3).get('title'), 'Changed');
			assert.equal(mineBinding.renders, 1); // the other list is told once, too
		});

		it('a detail fetch lands in the model the lists hold', async () => {
			const { api } = make();
			ti.respond(() => ({ status: 200, body: { data: items(1, 3) } }));
			await Alloy.Collections.jobs.fetch();
			const same = api.model('job', 2);
			assert.equal(same, Alloy.Collections.jobs.get(2));
			ti.respond(() => ({ status: 200, body: { data: { id: 2, title: 'Item 2', description: 'Only the detail has this' } } }));
			await same.fetch();
			assert.equal(Alloy.Collections.jobs.get(2).get('description'), 'Only the detail has this');
			assert.equal(api.createModel('job', { id: 2, extra: 1 }), same);
			assert.equal(same.get('extra'), 1);
			assert.equal(api.identity.get('job', 2), same);
		});

		it('api.model() gives an empty model for an id nobody loaded yet, and the list picks it up', async () => {
			const { api } = make();
			const early = api.model('job', 77);
			ti.respond(() => ({ status: 200, body: { data: [{ id: 77, title: 'Arrived' }] } }));
			await Alloy.Collections.jobs.fetch();
			assert.equal(Alloy.Collections.jobs.get(77), early);
			assert.equal(early.get('title'), 'Arrived');
		});

		it('is off unless asked for, and is cleared with the session', async () => {
			const off = make({ identity: false });
			ti.respond(() => ({ status: 200, body: { data: items(1, 2) } }));
			await Alloy.Collections.jobs.fetch();
			await Alloy.Collections.myJobs.fetch();
			assert.notEqual(Alloy.Collections.jobs.get(1), Alloy.Collections.myJobs.get(1));
			assert.equal(off.api.identity.get('job', 1), null);
			uninstallAlloy();
			ti.uninstall();
			installAlloy(Backbone);
			const on = make();
			ti.respond(() => ({ status: 200, body: { data: items(1, 2) } }));
			await Alloy.Collections.jobs.fetch();
			const first = on.api.identity.get('job', 1);
			assert.ok(first);
			on.api.session.reset();
			assert.equal(on.api.identity.get('job', 1), null);
		});

		it('forgets a destroyed model', async () => {
			const { api } = make();
			ti.respond(() => ({ status: 200, body: { data: items(1, 2) } }));
			await Alloy.Collections.jobs.fetch();
			ti.respond(() => ({ status: 204 }));
			await Alloy.Collections.jobs.get(1).destroy();
			assert.equal(api.identity.get('job', 1), null);
		});
	});

	describe('optimistic updates on Backbone ' + version, () => {
		let ti;

		beforeEach(() => installAlloy(Backbone));
		afterEach(() => {
			uninstallAlloy();
			if (ti) {
				ti.uninstall();
			}
		});

		function make(extra) {
			const made = setup({ methods: METHODS, models: models(extra) });
			ti = made.ti;
			Alloy.Collections.jobs.reset(items(1, 4));
			return made;
		}

		it('save shows the change at once and keeps it when the server agrees', async () => {
			make();
			ti.respond(() => null);
			const job = Alloy.Collections.jobs.get(2);
			const handle = job.save({ title: 'Mine now' }, { optimistic: true, patch: true });
			assert.equal(job.get('title'), 'Mine now');
			ti.last.respond({ status: 200, body: { data: { id: 2, title: 'Mine now', updated: true } } });
			await handle;
			assert.equal(job.get('title'), 'Mine now');
			assert.equal(job.get('updated'), true);
		});

		it('save rolls back when the server refuses, and tells the caller', async () => {
			make();
			ti.respond(() => null);
			const job = Alloy.Collections.jobs.get(2);
			const events = record(job);
			const failures = [];
			const handle = job.save({ title: 'Rejected', fresh: 'attribute' }, { optimistic: true, error: (target, error) => failures.push(error.status) });
			assert.equal(job.get('title'), 'Rejected');
			ti.last.respond({ status: 422, body: { errors: { title: ['no'] } } });
			assert.equal((await rejection(handle)).status, 422);
			assert.equal(job.get('title'), 'Item 2');
			assert.equal(job.has('fresh'), false);
			assert.deepEqual(failures, [422]);
			assert.equal(events.count('rollback'), 1);
		});

		it('rollback leaves alone what changed again in the meantime', async () => {
			make();
			ti.respond(() => null);
			const job = Alloy.Collections.jobs.get(2);
			const handle = job.save({ title: 'First try', done: true }, { optimistic: true });
			job.set({ title: 'Typed since' });
			ti.last.respond({ status: 500 });
			await rejection(handle);
			assert.equal(job.get('title'), 'Typed since');
			assert.equal(job.has('done'), false);
		});

		it('fires the error event on rollback when there is no error callback', async () => {
			make();
			ti.respond(() => ({ status: 500 }));
			const job = Alloy.Collections.jobs.get(2);
			const events = record(job);
			await rejection(job.save({ title: 'x' }, { optimistic: true }));
			assert.equal(events.count('error'), 1);
			assert.equal(job.get('title'), 'Item 2');
		});

		it('destroy removes at once and puts the model back where it was on failure', async () => {
			make();
			ti.respond(() => null);
			const jobs = Alloy.Collections.jobs;
			const job = jobs.get(2);
			const handle = job.destroy({ optimistic: true });
			assert.deepEqual(jobs.pluck('id'), [1, 3, 4]);
			ti.last.respond({ status: 409, body: { message: 'has offers' } });
			assert.equal((await rejection(handle)).status, 409);
			assert.deepEqual(jobs.pluck('id'), [1, 2, 3, 4]);
			assert.equal(jobs.get(2), job);
		});

		it('destroy stays removed when the server agrees', async () => {
			make();
			ti.respond(() => ({ status: 204 }));
			const jobs = Alloy.Collections.jobs;
			await jobs.get(2).destroy({ optimistic: true });
			assert.deepEqual(jobs.pluck('id'), [1, 3, 4]);
		});

		it('create shows the new model at once and takes it out again on failure', async () => {
			make();
			ti.respond(() => null);
			const jobs = Alloy.Collections.jobs;
			const failures = [];
			const created = jobs.create({ title: 'Draft' }, { optimistic: true, error: (target, error) => failures.push(error.status) });
			assert.equal(jobs.length, 5);
			assert.equal(jobs.at(4), created);
			ti.last.respond({ status: 422 });
			await wait(5);
			assert.equal(jobs.length, 4);
			assert.deepEqual(failures, [422]);
		});

		it('create keeps the model and gives it the server\'s id on success', async () => {
			make();
			ti.respond(() => ({ status: 201, body: { data: { id: 50, title: 'Draft' } } }));
			const jobs = Alloy.Collections.jobs;
			const created = jobs.create({ title: 'Draft' }, { optimistic: true });
			await wait(5);
			assert.equal(created.id, 50);
			assert.equal(jobs.get(50), created);
		});

		it('can be the default for a model', async () => {
			make({ optimistic: true });
			ti.respond(() => ({ status: 500 }));
			const job = Alloy.Collections.jobs.get(1);
			await rejection(job.save({ title: 'Nope' }));
			assert.equal(job.get('title'), 'Item 1');
			await rejection(job.save({ title: 'Kept' }, { optimistic: false }));
			assert.equal(job.get('title'), 'Kept'); // Backbone's own behaviour: no rollback
		});
	});
});
