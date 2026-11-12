'use strict';

/* Lists that follow a collection, and optimistic writes whose request is any call. */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rejection, wait } = require('../helpers/setup');
const { eachBackbone, installAlloy, uninstallAlloy, record } = require('../helpers/backbone');

const STATUSES = ['open', 'open', 'done'];
const all = Array.from({ length: 30 }, (unused, index) => ({ id: index + 1, title: 'Job ' + (index + 1), status: STATUSES[index % 3] }));

function serve(request) {
	const url = new URL(request.url);
	const query = url.searchParams;
	if (url.pathname.endsWith('/jobs')) {
		const rows = query.get('status') ? all.filter(job => job.status === query.get('status')) : all;
		const perPage = Number(query.get('per_page') || 5);
		const page = Number(query.get('page') || 1);
		return { status: 200, body: { data: rows.slice((page - 1) * perPage, page * perPage), meta: { current_page: page, last_page: Math.ceil(rows.length / perPage), total: rows.length } } };
	}
	if (url.pathname.endsWith('/messages')) {
		const limit = Number(query.get('limit') || 5);
		if (query.get('after')) {
			return { status: 200, body: { data: all.filter(item => item.id > Number(query.get('after'))).slice(0, limit), meta: { has_more: false } } };
		}
		const older = query.get('before') ? all.filter(item => item.id < Number(query.get('before'))) : all;
		return { status: 200, body: { data: older.slice(-limit), meta: { has_more: older.length > limit } } };
	}
	if (url.pathname.endsWith('/feed')) { // newest first
		const limit = Number(query.get('limit') || 5);
		const newestFirst = all.slice().reverse();
		if (query.get('after')) {
			return { status: 200, body: { data: newestFirst.filter(item => item.id > Number(query.get('after'))).slice(-limit), meta: { has_more: false } } };
		}
		const older = query.get('before') ? newestFirst.filter(item => item.id < Number(query.get('before'))) : newestFirst;
		return { status: 200, body: { data: older.slice(0, limit), meta: { has_more: older.length > limit } } };
	}
	if (url.pathname.endsWith('/plain')) {
		return { status: 200, body: { data: all.slice(0, 4) } };
	}
	return { status: 404 };
}

eachBackbone((Backbone, version) => {
	describe('lists that follow a collection on Backbone ' + version, () => {
		let ti;
		let api;
		let jobs;

		beforeEach(() => {
			installAlloy(Backbone);
			const made = setup({
				meta: 'meta',
				methods: [
					{ name: 'getJobs', get: 'jobs', paginate: { style: 'page', perPage: 5 } },
					{ name: 'getMessages', get: 'messages', paginate: { style: 'cursor', limit: 5 } },
					{ name: 'getFeed', get: 'feed', paginate: { style: 'cursor', limit: 5, order: 'desc' } },
					{ name: 'getPlain', get: 'plain' },
					{ name: 'markDone', post: 'jobs/<id>/done' },
					{ name: 'send', post: 'messages' }
				],
				models: [
					{ name: 'job', collections: [{ name: 'jobs', read: 'getJobs', content: 'data' }, { name: 'plain', read: 'getPlain', content: 'data' }] },
					{ name: 'message', collections: [{ name: 'messages', read: 'getMessages', content: 'data' }, { name: 'feed', read: 'getFeed', content: 'data' }] }
				]
			});
			ti = made.ti;
			api = made.api;
			ti.respond(serve);
			jobs = Alloy.Collections.jobs;
		});
		afterEach(() => {
			uninstallAlloy();
			ti.uninstall();
		});

		const ids = list => list.models().map(model => model.id);

		function openList(extra) {
			return api.list(Object.assign({ collection: 'jobs', query: { status: 'open' }, filter: model => model.get('status') === 'open' }, extra));
		}

		it('loads pages into the collection and keeps its own order', async () => {
			const list = openList();
			const states = [];
			list.on('state', state => states.push(state));
			let changes = 0;
			list.on('change', () => changes++);
			await list.load();
			assert.deepEqual(ids(list), [1, 2, 4, 5, 7]);
			assert.equal(new URL(ti.last.url).search, '?status=open&page=1&per_page=5');
			assert.deepEqual(states, ['loading', 'idle']);
			assert.equal(list.total, 20);
			assert.equal(list.hasMore(), true);
			await list.loadMore();
			assert.deepEqual(ids(list), [1, 2, 4, 5, 7, 8, 10, 11, 13, 14]);
			assert.equal(jobs.length, 10); // the collection holds every model any list loaded
			await wait();
			assert.equal(changes, 2); // one per page
			assert.deepEqual(states, ['loading', 'idle', 'loadingMore', 'idle']);
		});

		it('two lists share the collection\'s models', async () => {
			const open = openList();
			const everything = api.list({ collection: jobs });
			await open.load();
			await everything.load();
			assert.equal(everything.models()[0], open.models()[0]);
			assert.deepEqual(ids(everything), [1, 2, 3, 4, 5]);
			assert.deepEqual(ids(open), [1, 2, 4, 5, 7]);
		});

		it('shows what the collection already holds before the first answer', async () => {
			jobs.reset([{ id: 2, title: 'Cached', status: 'open' }, { id: 3, title: 'Not mine', status: 'done' }]);
			const list = openList();
			ti.respond(() => null);
			const loading = list.load();
			assert.deepEqual(ids(list), [2]);
			assert.equal(list.state, 'refreshing');
			ti.last.respond(serve(ti.last));
			await loading;
			assert.deepEqual(ids(list), [1, 2, 4, 5, 7]);
			assert.equal(list.models()[1].get('title'), 'Job 2'); // the cached model, updated in place
		});

		it('a model that reaches the collection another way joins when it passes the filter', async () => {
			const list = openList();
			await list.load();
			jobs.upsert({ id: 99, title: 'From a socket', status: 'open' });
			jobs.upsert({ id: 98, title: 'Not open', status: 'done' });
			jobs.add({ id: 97, title: 'Plain add', status: 'open' });
			assert.deepEqual(ids(list), [97, 99, 1, 2, 4, 5, 7]);
			const tail = openList({ place: 'end' });
			await tail.load();
			jobs.upsert({ id: 96, title: 'Later', status: 'open' });
			assert.equal(ids(tail).pop(), 96);
		});

		it('a member that stops passing the filter drops out, and one that starts to joins', async () => {
			const list = openList();
			await list.load();
			let changes = 0;
			list.on('change', () => changes++);
			jobs.get(2).set({ status: 'done' });
			assert.deepEqual(ids(list), [1, 4, 5, 7]);
			jobs.upsert({ id: 4, status: 'done' });
			assert.deepEqual(ids(list), [1, 5, 7]);
			jobs.upsert({ id: 77, title: 'x', status: 'done' });
			jobs.get(77).set({ status: 'open' });
			assert.deepEqual(ids(list), [77, 1, 5, 7]);
			jobs.get(1).set({ title: 'Renamed' });
			await wait();
			assert.equal(changes, 1); // everything in this turn: one change
		});

		it('follows removals and resets of the collection', async () => {
			const list = openList();
			await list.load();
			jobs.remove(jobs.get(4));
			assert.deepEqual(ids(list), [1, 2, 5, 7]);
			jobs.reset([jobs.get(1), jobs.get(7)]);
			assert.deepEqual(ids(list), [1, 7]);
		});

		it('a page that brings a model which had joined puts it where the server has it', async () => {
			const list = openList();
			await list.load();
			jobs.upsert({ id: 8, title: 'Arrived early', status: 'open' }); // page 2 will bring it
			assert.deepEqual(ids(list), [8, 1, 2, 4, 5, 7]);
			await list.loadMore();
			assert.deepEqual(ids(list), [1, 2, 4, 5, 7, 8, 10, 11, 13, 14]);
		});

		it('refresh() replaces the order with the first page; the collection keeps the rest', async () => {
			const list = openList();
			await list.load();
			await list.loadMore();
			const first = list.models()[0];
			await list.refresh();
			assert.deepEqual(ids(list), [1, 2, 4, 5, 7]);
			assert.equal(list.models()[0], first);
			assert.equal(jobs.length, 10);
		});

		it('reload() switches filters and drops answers to the old ones', async () => {
			const list = openList();
			await list.load();
			ti.respond(() => null);
			const stale = list.loadMore();
			const pending = ti.last;
			ti.respond(serve);
			await list.reload({ query: { status: 'done' }, filter: model => model.get('status') === 'done' });
			pending.respond(serve(pending));
			await stale;
			assert.deepEqual(ids(list), [3, 6, 9, 12, 15]);
			assert.equal(list.total, 10);
		});

		it('reports errors, keeps the rows, and retry() repeats what failed', async () => {
			const list = openList();
			await list.load();
			const errors = [];
			list.on('error', error => errors.push(error.status));
			ti.respond(() => ({ status: 503 }));
			await list.loadMore();
			assert.deepEqual([list.state, list.failedMore, list.error.status, ids(list).length], ['error', true, 503, 5]);
			assert.deepEqual(errors, [503]);
			ti.respond(serve);
			await list.retry();
			assert.equal(list.state, 'idle');
			assert.equal(ids(list).length, 10);
			ti.respond(() => ({ status: 500 }));
			await list.refresh();
			assert.equal(list.failedMore, false);
		});

		it('a cursor list loads older at the start and newer at the end; new models join at the end', async () => {
			const thread = api.list({ collection: 'messages' });
			await thread.load();
			assert.deepEqual(ids(thread), [26, 27, 28, 29, 30]);
			await thread.loadOlder();
			assert.deepEqual(ids(thread), [21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
			Alloy.Collections.messages.upsert({ id: 31, title: 'From the socket' });
			assert.equal(ids(thread).pop(), 31);
			all.push({ id: 32, title: 'Missed while offline' });
			try {
				await thread.loadNewer();
				assert.deepEqual(ids(thread).slice(-3), [30, 31, 32]);
				assert.equal(new URL(ti.last.url).searchParams.get('after'), '31');
			} finally {
				all.pop();
			}
		});

		// ---- what a page cannot know: it speaks for the list as it was when the page was asked for

		/** Leaves every request unanswered; the test answers them by hand (request.respond). */
		const hold = () => ti.respond(() => null);
		const page = rows => ({ status: 200, body: { data: rows, meta: { current_page: 1, last_page: 4, total: 20 } } });
		const newer = rows => ({ status: 200, body: { data: rows, meta: { has_more: false } } });

		it('a refresh settles a row that had joined before it was asked for; one that joins while it is out stays', async () => {
			const list = openList();
			await list.load();
			jobs.upsert({ id: 91, title: 'Before', status: 'open' }); // joined, then the refresh is asked for
			hold();
			const refreshing = list.refresh();
			const pending = ti.last;
			jobs.upsert({ id: 92, title: 'Created meanwhile', status: 'open' }); // the page on its way cannot have it
			pending.respond(serve(pending));
			await refreshing;
			assert.deepEqual(ids(list), [92, 1, 2, 4, 5, 7]);
			// A page asked for after it joined is the server's word about it: here it has the row ...
			const placing = list.refresh();
			ti.last.respond(page([{ id: 1, status: 'open' }, { id: 92, status: 'open' }, { id: 2, status: 'open' }]));
			await placing;
			assert.deepEqual(ids(list), [1, 92, 2]);
			// ... and here it does not.
			const dropping = list.refresh();
			ti.last.respond(serve(ti.last));
			await dropping;
			assert.deepEqual(ids(list), [1, 2, 4, 5, 7]);
		});

		it('the same without pagination, and for the first page of a cursor list', async () => {
			const plain = api.list({ collection: 'plain' });
			await plain.load();
			Alloy.Collections.plain.upsert({ id: 91 });
			hold();
			let refreshing = plain.refresh();
			let pending = ti.last;
			Alloy.Collections.plain.upsert({ id: 92 });
			pending.respond(serve(pending));
			await refreshing;
			assert.deepEqual(ids(plain), [92, 1, 2, 3, 4]);

			ti.respond(serve);
			const thread = api.list({ collection: 'messages' });
			await thread.load();
			Alloy.Collections.messages.upsert({ id: 91 });
			hold();
			refreshing = thread.refresh();
			pending = ti.last;
			Alloy.Collections.messages.upsert({ id: 92 });
			pending.respond(serve(pending));
			await refreshing;
			assert.deepEqual(ids(thread), [26, 27, 28, 29, 30, 92]); // an oldest-first list: it joined at the end
		});

		it('a row that reaches the collection while the first page is out joins when the page lands', async () => {
			const list = openList();
			hold();
			const loading = list.load();
			const pending = ti.last;
			jobs.upsert({ id: 92, title: 'Created meanwhile', status: 'open' });
			jobs.upsert({ id: 93, title: 'Not open', status: 'done' });
			assert.deepEqual(ids(list), []); // nothing is shown before the first answer
			pending.respond(serve(pending));
			await loading;
			assert.deepEqual(ids(list), [92, 1, 2, 4, 5, 7]);
			// A first load that fails, and its retry: the retry was asked for afterwards and decides.
			const failing = openList({ query: { status: 'done' }, filter: model => model.get('status') === 'done' });
			const failed = failing.load();
			const first = ti.last;
			jobs.upsert({ id: 94, title: 'Done meanwhile', status: 'done' });
			first.respond({ status: 503 });
			await failed;
			assert.equal(failing.state, 'error');
			const retried = failing.retry();
			ti.last.respond(serve(ti.last));
			await retried;
			assert.deepEqual(ids(failing), [3, 6, 9, 12, 15]);
		});

		it('an empty first page keeps what was written while it was out', async () => {
			const messages = Alloy.Collections.messages;
			const thread = api.list({ collection: 'messages' });
			hold();
			const loading = thread.load();
			const first = ti.last;
			const sending = messages.optimistic({ id: 'tmp-1', title: 'The first message' }, () => api.send({ body: {} }));
			await wait();
			const post = ti.last;
			first.respond(newer([])); // nothing existed when it was asked for
			await loading;
			assert.deepEqual(ids(thread), ['tmp-1']);
			assert.equal(thread.isEmpty(), false);
			post.respond({ status: 201, body: { id: 31, title: 'The first message' } });
			await sending;
			assert.deepEqual(ids(thread), [31]);
			// The same on a thread that was loaded and empty, refreshed while the next one is written.
			const refreshing = thread.refresh();
			const second = ti.last;
			messages.upsert({ id: 32, title: 'An answer, from a socket' });
			second.respond(newer([{ id: 31, title: 'The first message' }]));
			await refreshing;
			assert.deepEqual(ids(thread), [31, 32]);
		});

		it('a newer page puts its rows before the ones that joined while it was out', async () => {
			const thread = api.list({ collection: 'messages' });
			await thread.load();
			hold();
			let catching = thread.loadNewer(); // after a reconnect, say
			let pending = ti.last;
			assert.equal(new URL(pending.url).searchParams.get('after'), '30');
			Alloy.Collections.messages.upsert({ id: 33, title: 'Arrived meanwhile' });
			pending.respond(newer([{ id: 31 }, { id: 32 }])); // what was missed, asked for before 33 existed
			await catching;
			assert.deepEqual(ids(thread), [26, 27, 28, 29, 30, 31, 32, 33]);
			// When the page does bring such a row it takes its place in the page, as ever.
			catching = thread.loadNewer();
			pending = ti.last;
			Alloy.Collections.messages.upsert({ id: 36 });
			pending.respond(newer([{ id: 34 }, { id: 35 }, { id: 36 }, { id: 37 }]));
			await catching;
			assert.deepEqual(ids(thread), [26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37]);

			// Newest first: rows join at the start, and the newer page goes under the ones that joined meanwhile.
			ti.respond(serve);
			const feed = api.list({ collection: 'feed' });
			await feed.load();
			assert.deepEqual(ids(feed), [30, 29, 28, 27, 26]);
			hold();
			catching = feed.loadNewer();
			pending = ti.last;
			assert.equal(new URL(pending.url).searchParams.get('after'), '30');
			Alloy.Collections.feed.upsert({ id: 43 });
			pending.respond(newer([{ id: 42 }, { id: 41 }]));
			await catching;
			assert.deepEqual(ids(feed), [43, 42, 41, 30, 29, 28, 27, 26]);
		});

		it('a cursor is never taken from a row the device is still creating', async () => {
			const messages = Alloy.Collections.messages;
			const thread = api.list({ collection: 'messages' });
			await thread.load();
			hold();
			const sending = messages.optimistic({ id: 'tmp-2', title: 'On its way' }, () => api.send({ body: {} }));
			await wait();
			const post = ti.last;
			assert.deepEqual(ids(thread), [26, 27, 28, 29, 30, 'tmp-2']);
			const catching = thread.loadNewer();
			const pending = ti.last;
			assert.equal(new URL(pending.url).searchParams.get('after'), '30'); // not an id the server has never seen
			pending.respond(newer([{ id: 31 }]));
			await catching;
			assert.deepEqual(ids(thread), [26, 27, 28, 29, 30, 31, 'tmp-2']); // and what it brings goes before the draft
			post.respond({ status: 201, body: { id: 32, title: 'On its way' } });
			await sending;
			assert.deepEqual(ids(thread), [26, 27, 28, 29, 30, 31, 32]);

			// The collection's own pages follow the same rule.
			ti.respond(serve);
			const feed = Alloy.Collections.feed;
			await feed.refresh();
			hold();
			feed.optimistic({ id: 'tmp-3', title: 'On its way' }, () => api.send({ body: {} }), { at: 0 }).catch(() => {});
			feed.fetchPrevious().catch(() => {});
			assert.equal(new URL(ti.last.url).searchParams.get('after'), '30');
		});

		it('a refresh asked for twice, or while the first load is out, is one request: what joined since it was sent stays', async () => {
			const list = openList();
			await list.load();
			hold();
			const sent = ti.requests.length;
			const first = list.refresh();
			const pending = ti.last;
			jobs.upsert({ id: 92, title: 'Created meanwhile', status: 'open' });
			const second = list.refresh(); // joins the request that is out: it was sent before the row joined
			assert.equal(ti.requests.length, sent + 1);
			pending.respond(serve(pending));
			await Promise.all([first, second]);
			assert.deepEqual(ids(list), [92, 1, 2, 4, 5, 7]);

			const other = openList({ query: { status: 'done' }, filter: model => model.get('status') === 'done' });
			const loading = other.load();
			const page1 = ti.last;
			jobs.upsert({ id: 93, title: 'Done meanwhile', status: 'done' });
			const refreshing = other.refresh();
			page1.respond(serve(page1));
			await Promise.all([loading, refreshing]);
			assert.deepEqual(ids(other), [93, 3, 6, 9, 12, 15]);
		});

		it('a row the device is creating is not dropped by a refresh, whenever that was asked for', async () => {
			const messages = Alloy.Collections.messages;
			const thread = api.list({ collection: 'messages' });
			await thread.load();
			hold();
			// Written before the refresh is asked for and still unanswered when it lands.
			let sending = messages.optimistic({ id: 'tmp-1', title: 'Slow' }, () => api.send({ body: {} }));
			await wait();
			let post = ti.last;
			let refreshing = thread.refresh();
			let get = ti.last;
			get.respond(serve(get));
			await refreshing;
			assert.deepEqual(ids(thread), [26, 27, 28, 29, 30, 'tmp-1']);
			post.respond({ status: 201, body: { id: 31, title: 'Slow' } });
			await sending;
			assert.deepEqual(ids(thread), [26, 27, 28, 29, 30, 31]);

			// Written before the refresh is asked for and answered while it is out: the page was made before
			// the server had the row, the row has its real id by the time the page lands.
			sending = messages.optimistic({ id: 'tmp-2', title: 'Answered meanwhile' }, () => api.send({ body: {} }));
			await wait();
			post = ti.last;
			refreshing = thread.refresh();
			get = ti.last;
			post.respond({ status: 201, body: { id: 32, title: 'Answered meanwhile' } });
			await sending;
			get.respond(newer([{ id: 27 }, { id: 28 }, { id: 29 }, { id: 30 }, { id: 31 }]));
			await refreshing;
			assert.deepEqual(ids(thread), [27, 28, 29, 30, 31, 32]);
			// The next refresh was asked for after the answer: the server's word again.
			refreshing = thread.refresh();
			ti.last.respond(newer([{ id: 28 }, { id: 29 }, { id: 30 }, { id: 31 }, { id: 32 }]));
			await refreshing;
			assert.deepEqual(ids(thread), [28, 29, 30, 31, 32]);
			refreshing = thread.refresh();
			ti.last.respond(newer([{ id: 28 }, { id: 29 }, { id: 30 }, { id: 31 }]));
			await refreshing;
			assert.deepEqual(ids(thread), [28, 29, 30, 31]);
		});

		it('a row that joins while a refresh is out and is then taken back or replaced leaves one row or none', async () => {
			const messages = Alloy.Collections.messages;
			const thread = api.list({ collection: 'messages' });
			await thread.load();
			hold();
			// Refused by the server: gone, and the page does not bring it back.
			let refreshing = thread.refresh();
			let get = ti.last;
			let sending = messages.optimistic({ id: 'tmp-1', title: 'Refused' }, () => api.send({ body: {} }));
			await wait();
			ti.last.respond({ status: 422 });
			await rejection(sending);
			get.respond(serve(get));
			await refreshing;
			assert.deepEqual(ids(thread), [26, 27, 28, 29, 30]);

			// The server's copy arrives through a socket before the answer does: that one stays, once.
			refreshing = thread.refresh();
			get = ti.last;
			sending = messages.optimistic({ id: 'tmp-2', title: 'Sent' }, () => api.send({ body: {} }));
			await wait();
			const post = ti.last;
			messages.upsert({ id: 31, title: 'Sent' });
			post.respond({ status: 201, body: { id: 31, title: 'Sent' } });
			await sending;
			get.respond(serve(get));
			await refreshing;
			assert.deepEqual(ids(thread), [26, 27, 28, 29, 30, 31]);
			assert.equal(messages.get('tmp-2'), undefined);
		});

		it('a refresh that lands after a newer page keeps what that page brought', async () => {
			const thread = api.list({ collection: 'messages' });
			await thread.load();
			hold();
			const refreshing = thread.refresh();
			const older = ti.last;
			const catching = thread.loadNewer(); // asked for later, answered first
			const later = ti.last;
			later.respond(newer([{ id: 31 }]));
			await catching;
			assert.deepEqual(ids(thread), [26, 27, 28, 29, 30, 31]);
			older.respond(serve(older)); // made before 31 existed
			await refreshing;
			assert.deepEqual(ids(thread), [26, 27, 28, 29, 30, 31]);
			// And the other way round: the refresh first, then the newer page that was asked for from the old list.
			const again = thread.refresh();
			const first = ti.last;
			const more = thread.loadNewer();
			const second = ti.last;
			first.respond(newer([{ id: 28 }, { id: 29 }, { id: 30 }, { id: 31 }, { id: 32 }]));
			await again;
			second.respond(newer([{ id: 32 }, { id: 33 }]));
			await more;
			assert.deepEqual(ids(thread), [28, 29, 30, 31, 32, 33]);
		});

		it('a row whose filter result changes while a page is out is where the device last put it', async () => {
			const list = openList();
			await list.load();
			jobs.upsert({ id: 3, title: 'Job 3', status: 'done' }); // in the collection, not in this list
			hold();
			let refreshing = list.refresh();
			let get = ti.last;
			jobs.get(3).set({ status: 'open' }); // starts to belong: joins
			assert.deepEqual(ids(list), [3, 1, 2, 4, 5, 7]);
			get.respond(serve(get)); // asked for before that
			await refreshing;
			assert.deepEqual(ids(list), [3, 1, 2, 4, 5, 7]);

			// A member the device marks done while a page that still lists it is on its way.
			refreshing = list.refresh();
			get = ti.last;
			const marking = jobs.get(2).optimistic({ status: 'done' }, () => api.markDone({ id: 2 }));
			await wait();
			const post = ti.last;
			assert.deepEqual(ids(list), [3, 1, 4, 5, 7]);
			get.respond(serve(get)); // the server's list from before the change: 2 is open in it
			await refreshing;
			assert.equal(jobs.get(2).get('status'), 'done');
			assert.deepEqual(ids(list), [1, 4, 5, 7]); // (and 3, which joined before this refresh, is settled by it)
			post.respond({ status: 200, body: { id: 2, status: 'done' } });
			await marking;
			assert.deepEqual(ids(list), [1, 4, 5, 7]);
		});

		it('a page that a reload or a refresh overtook brings nothing into the list, also when `load` merged its rows itself', async () => {
			// The app's loader merges every answer into the collection, whether or not the list still waits for it.
			const asked = [];
			const list = api.list({
				collection: 'jobs', paginate: { style: 'page', perPage: 2 },
				load: query => new Promise((resolve) => {
					asked.push({ query, answer: (rows, last) => resolve({ items: jobs.upsert(rows).models, meta: { current_page: query.page, last_page: last || 1 } }) });
				})
			});
			const first = list.load();
			const second = list.reload({ query: { q: 'other' } }); // other filters while the first page is out
			asked[0].answer([{ id: 71 }]); // the overtaken page arrives first ...
			asked[1].answer([{ id: 72 }]);
			await Promise.all([first, second]);
			assert.deepEqual(ids(list), [72]);
			const third = list.reload({ query: { q: 'again' } });
			const fourth = list.reload({ query: { q: 'and again' } });
			asked[3].answer([{ id: 74 }], 2);
			await fourth;
			asked[2].answer([{ id: 73 }]); // ... or last
			await third;
			assert.deepEqual(ids(list), [74]);
			// A next page overtaken by a refresh, landing before the refreshed page and after it.
			const more = list.loadMore();
			const refreshing = list.refresh();
			asked[4].answer([{ id: 75 }], 2);
			asked[5].answer([{ id: 74 }], 2);
			await Promise.all([more, refreshing]);
			assert.deepEqual(ids(list), [74]);
			const again = list.loadMore();
			const refreshed = list.refresh();
			asked[7].answer([{ id: 74 }], 2);
			await refreshed;
			asked[6].answer([{ id: 76 }], 2);
			await again;
			assert.deepEqual(ids(list), [74]);
			// What the overtaken page shares with rows that joined on their own before it was asked for stays.
			jobs.upsert({ id: 77 });
			const late = list.loadMore();
			const final = list.refresh();
			asked[8].answer([{ id: 77 }, { id: 78 }], 2);
			await late;
			assert.deepEqual(ids(list), [77, 74]);
			asked[9].answer([{ id: 74 }, { id: 77 }], 2);
			await final;
			assert.deepEqual(ids(list), [74, 77]);
		});

		it('without pagination and with `load`: a refresh overtaken by the next one does not answer for it', async () => {
			const own = new Backbone.Collection();
			const asked = [];
			const list = api.list({ collection: own, paginate: false, load: () => new Promise(resolve => asked.push(resolve)) });
			const first = list.load();
			const second = list.refresh(); // `load` cannot be aborted: both are out
			asked[1]([{ id: 2 }]);
			await second;
			assert.deepEqual(ids(list), [2]);
			asked[0]([{ id: 1 }]); // made before the one that is shown
			await first;
			assert.deepEqual(ids(list), [2]);
			assert.equal(list.state, 'idle');
		});

		it('works without pagination', async () => {
			const list = api.list({ collection: 'plain' });
			await list.load();
			assert.deepEqual(ids(list), [1, 2, 3, 4]);
			assert.equal(list.hasMore(), false);
			assert.equal(await list.loadMore(), null);
			assert.equal(list.isEmpty(), false);
		});

		it('destroy() cancels its requests and stops following; a signal does the same', async () => {
			const list = openList();
			ti.respond(() => null);
			list.load();
			list.destroy();
			assert.equal(ti.last.aborted, true);
			ti.respond(serve);
			const controller = api.createAbortController();
			const other = openList({ signal: controller.signal });
			await other.load();
			controller.abort();
			jobs.upsert({ id: 500, status: 'open' });
			assert.equal(ids(other).indexOf(500), -1);
		});

		it('schedule lets the app decide when changes are delivered', async () => {
			const queue = [];
			const list = openList({ schedule: run => queue.push(run) });
			let changes = 0;
			list.on('change', () => changes++);
			await list.load();
			assert.equal(changes, 0);
			queue.splice(0).forEach(run => run());
			assert.equal(changes, 1);
		});

		it('needs a collection from the models config', () => {
			assert.throws(() => api.list({ collection: new Backbone.Collection() }), /needs a collection/);
			assert.throws(() => api.list({ collection: 'jobs', method: 'nope' }), /not defined/);
		});

		it('loads its pages through a function of the app when given `load`', async () => {
			const asked = [];
			const open = all.filter(job => job.status === 'open');
			const list = api.list({
				collection: 'jobs', filter: model => model.get('status') === 'open',
				load(query, context) {
					asked.push(query);
					assert.equal(context.signal.aborted, false);
					return wait(1).then(() => ({ items: open.slice((query.page - 1) * 5, query.page * 5), meta: { current_page: query.page, last_page: 4, total: 20 } }));
				}
			});
			const states = [];
			list.on('state', state => states.push(state));
			const loading = list.load();
			assert.equal(asked.length, 1); // asked before load() returns, as a method would be called
			await loading;
			assert.deepEqual(ids(list), [1, 2, 4, 5, 7]);
			assert.equal(list.total, 20);
			assert.equal(list.hasMore(), true);
			await list.loadMore();
			assert.deepEqual(asked, [{ page: 1, per_page: 5 }, { page: 2, per_page: 5 }]);
			assert.deepEqual(ids(list), [1, 2, 4, 5, 7, 8, 10, 11, 13, 14]);
			assert.equal(jobs.length, 10); // the list merged the rows into the collection
			assert.equal(ti.requests.length, 0); // and sent nothing itself
			assert.deepEqual(states, ['loading', 'idle', 'loadingMore', 'idle']);
		});

		it('`load` may hand over models it merged itself; what it rejects with is the list\'s error', async () => {
			let down = false;
			const list = api.list({
				collection: 'jobs',
				load: query => (down ? Promise.reject(new Error('down')) : Promise.resolve({
					items: jobs.upsert(all.slice((query.page - 1) * 5, query.page * 5)).models, meta: { current_page: query.page, last_page: 6 }
				}))
			});
			await list.load();
			await list.loadMore();
			assert.deepEqual(ids(list), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // in the pages' order, although they joined first
			assert.equal(list.models()[0], jobs.get(1));
			down = true;
			const errors = [];
			list.on('error', error => errors.push(error.message));
			await list.loadMore();
			assert.equal(list.state, 'error');
			assert.equal(list.failedMore, true);
			assert.deepEqual(errors, ['down']);
			assert.equal(ids(list).length, 10);
			const throwing = api.list({ collection: 'jobs', load: () => { throw new Error('threw'); } });
			throwing.on('error', error => errors.push(error.message));
			await throwing.load(); // never a throw from load(): the list's error
			assert.deepEqual(errors, ['down', 'threw']);
		});

		it('follows a collection the app created itself when the pages come from `load`', async () => {
			const own = new Backbone.Collection();
			const asked = [];
			const list = api.list({
				collection: own, paginate: { style: 'cursor', limit: 3 },
				load(query) {
					asked.push(query);
					const older = query.before ? all.filter(item => item.id < query.before) : all;
					return Promise.resolve({ items: older.slice(-3), meta: { has_more: older.length > 3 } });
				}
			});
			await list.load();
			assert.deepEqual(ids(list), [28, 29, 30]);
			await list.loadOlder();
			assert.deepEqual(asked, [{ limit: 3 }, { limit: 3, before: 28 }]);
			assert.deepEqual(ids(list), [25, 26, 27, 28, 29, 30]);
			assert.equal(own.length, 6);
			own.add({ id: 31 }); // from anywhere else: joins at the end of an oldest-first list
			own.remove(own.get(29));
			assert.deepEqual(ids(list), [25, 26, 27, 28, 30, 31]);
			list.destroy();
			own.add({ id: 32 });
			assert.deepEqual(ids(list), [25, 26, 27, 28, 30, 31]);
		});
	});

	describe('models and collections the app created itself on Backbone ' + version, () => {
		let ti;
		let api;

		beforeEach(() => {
			installAlloy(Backbone);
			const made = setup({ models: [{ name: 'job', collections: [{ name: 'jobs' }] }] });
			ti = made.ti;
			api = made.api;
		});
		afterEach(() => {
			uninstallAlloy();
			ti.uninstall();
		});

		it('api.upsert() merges into any collection, with Backbone\'s own events', () => {
			const own = new Backbone.Collection([{ id: 1, title: 'A', place: { city: 'X' } }, { id: 9, title: 'Z' }]);
			const events = record(own);
			const result = api.upsert(own, [{ id: 2, title: 'B' }, { id: 1, title: 'A2' }]);
			assert.deepEqual(result.models.map(model => model.id), [2, 1]);
			assert.deepEqual(result.added.map(model => model.id), [2]);
			assert.equal(own.length, 3);
			assert.deepEqual(own.get(1).get('place'), { city: 'X' }); // what the items lack stays
			assert.equal(events.count('add'), 1);
			assert.equal(events.count('change:title'), 1);
			assert.equal(events.count('fetch'), 0);
			assert.ok(result.models[0].receivedAt > 0);
			assert.equal(api.upsert(own, { id: 3 }, { position: 'start' }).models[0], own.at(0));
			assert.equal(api.upsert(own, [{ id: 3 }, { id: 1, title: 'A2' }]).touched, false);
		});

		it('api.replace() makes any model hold exactly the attributes', () => {
			const me = new Backbone.Model({ id: 'u1', phone: '+1', stale: true });
			let changes = 0;
			me.on('change', () => changes++);
			assert.equal(api.replace(me, { id: 'u1', phone: null }), me);
			assert.deepEqual(me.toJSON(), { id: 'u1', phone: null });
			changes = 0;
			api.replace(me, { id: 'u1', phone: null });
			assert.equal(changes, 0);
		});

		it('api.optimistic() changes any model now and puts it back on failure', async () => {
			const me = new Backbone.Model({ id: 'u1', phone: null });
			const error = await rejection(api.optimistic(me, { phone: '+2', note: 'x' }, () => {
				assert.equal(me.get('phone'), '+2');
				return Promise.reject(new Error('refused'));
			}));
			assert.equal(error.message, 'refused');
			assert.equal(me.get('phone'), null);
			assert.equal(me.has('note'), false);
			assert.equal(await api.optimistic(me, { phone: '+3' }, () => Promise.resolve({ id: 'u1', phone: '+3', verified: true })), me);
			assert.equal(me.get('verified'), true);
		});

		it('api.optimistic() adds to any collection now, then takes the server\'s id or goes away', async () => {
			const own = new Backbone.Collection([{ id: 1 }]);
			const sending = api.optimistic(own, { id: 'tmp', title: 'New' }, () => wait(1).then(() => ({ id: 50, title: 'New' })));
			const temporary = own.get('tmp');
			assert.equal(temporary.get('title'), 'New');
			const created = await sending;
			assert.equal(created, temporary);
			assert.equal(created.id, 50);
			assert.equal(own.get(50), created);
			assert.equal(own.get('tmp'), undefined);
			await rejection(api.optimistic(own, { id: 'tmp2' }, () => Promise.reject(new Error('no'))));
			assert.equal(own.length, 2);
			// The server's copy arrived first: that one stays.
			const racing = api.optimistic(own, { id: 'tmp3' }, () => wait(5).then(() => ({ id: 60, confirmed: true })));
			api.upsert(own, { id: 60, from: 'socket' });
			const kept = own.get(60);
			assert.equal(await racing, kept);
			assert.equal(kept.get('confirmed'), true);
			assert.equal(own.length, 3);
		});

		it('the same functions take RESTe\'s own models and collections', async () => {
			const jobs = Alloy.Collections.jobs;
			const events = record(jobs);
			assert.equal(api.upsert(jobs, [{ id: 1, status: 'open' }]).models[0], jobs.get(1));
			assert.equal(events.count('fetch'), 1); // merged as jobs.upsert() does: announced once
			assert.equal(api.replace(jobs.get(1), { id: 1, status: 'done' }).get('status'), 'done');
			await api.optimistic(jobs.get(1), { status: 'open' }, () => Promise.resolve());
			assert.equal(jobs.get(1).get('status'), 'open');
			const created = await api.optimistic(jobs, { id: 't' }, () => Promise.resolve({ id: 2 }));
			assert.equal(jobs.get(2), created);
		});
	});

	describe('optimistic writes with any request on Backbone ' + version, () => {
		let ti;
		let api;
		let jobs;

		beforeEach(() => {
			installAlloy(Backbone);
			const made = setup({
				unwrap: 'data',
				methods: [{ name: 'markDone', post: 'jobs/<id>/done' }, { name: 'send', post: 'messages' }, { name: 'getJobs', get: 'jobs' }],
				models: [{ name: 'job', collections: [{ name: 'jobs', read: 'getJobs', content: 'data' }] }]
			});
			ti = made.ti;
			api = made.api;
			jobs = Alloy.Collections.jobs;
			jobs.reset([{ id: 1, status: 'open' }, { id: 2, status: 'open' }]);
		});
		afterEach(() => {
			uninstallAlloy();
			ti.uninstall();
		});

		it('model.optimistic() changes now, merges the answer, and rolls back on failure', async () => {
			const job = jobs.get(1);
			ti.respond(() => null);
			const saving = job.optimistic({ status: 'done' }, () => api.markDone({ id: 1 }));
			assert.equal(job.get('status'), 'done');
			await wait();
			ti.last.respond({ status: 200, body: { data: { id: 1, status: 'done', done_at: 'now' } } });
			assert.equal(await saving, job);
			assert.equal(job.get('done_at'), 'now');
			assert.ok(job.receivedAt > 0);
			ti.respond(() => ({ status: 409 }));
			let rollbacks = 0;
			job.on('rollback', () => rollbacks++);
			const error = await rejection(job.optimistic({ status: 'open', note: 'x' }, () => api.markDone({ id: 1 })));
			assert.equal(error.status, 409);
			assert.equal(job.get('status'), 'done');
			assert.equal(job.has('note'), false);
			assert.equal(rollbacks, 1);
		});

		it('collection.optimistic() shows the model now and gives it the server\'s id in place', async () => {
			ti.respond(() => null);
			const sending = jobs.optimistic({ id: 'tmp-1', status: 'open', sending: true }, () => api.send({ body: { text: 'hi' } }));
			const temporary = jobs.get('tmp-1');
			assert.equal(jobs.length, 3);
			await wait();
			ti.last.respond({ status: 201, body: { data: { id: 77, status: 'open', sending: false } } });
			const model = await sending;
			assert.equal(model, temporary);
			assert.equal(model.id, 77);
			assert.equal(jobs.get(77), temporary);
			assert.equal(jobs.get('tmp-1'), undefined);
			assert.equal(jobs.length, 3);
		});

		it('collection.optimistic() keeps the server\'s copy when a socket event beat the response', async () => {
			ti.respond(() => null);
			const sending = jobs.optimistic({ id: 'tmp-2', status: 'open' }, () => api.send({ body: {} }));
			await wait();
			jobs.upsert({ id: 78, status: 'open', from: 'socket' });
			const fromSocket = jobs.get(78);
			ti.last.respond({ status: 201, body: { data: { id: 78, status: 'open', confirmed: true } } });
			const model = await sending;
			assert.equal(model, fromSocket);
			assert.equal(model.get('confirmed'), true);
			assert.equal(jobs.length, 3);
			assert.equal(jobs.get('tmp-2'), undefined);
		});

		it('collection.optimistic() takes the model out again on failure', async () => {
			ti.respond(() => ({ status: 422 }));
			const error = await rejection(jobs.optimistic({ id: 'tmp-3', status: 'open' }, () => api.send({ body: {} })));
			assert.equal(error.status, 422);
			assert.equal(jobs.length, 2);
		});

		it('a list follows an optimistic model through its id change', async () => {
			ti.respond(request => (request.method === 'GET' ? { status: 200, body: { data: [{ id: 1, status: 'open' }, { id: 2, status: 'open' }] } } : null));
			const list = api.list({ collection: 'jobs', place: 'end' });
			await list.load();
			const sending = jobs.optimistic({ id: 'tmp-4', status: 'open' }, () => api.send({ body: {} }));
			assert.deepEqual(list.models().map(model => model.id), [1, 2, 'tmp-4']);
			await wait();
			ti.last.respond({ status: 201, body: { data: { id: 80, status: 'open' } } });
			await sending;
			assert.deepEqual(list.models().map(model => model.id), [1, 2, 80]);
		});
	});
});

describe('smaller additions', () => {
	let ti;
	afterEach(() => ti && ti.uninstall());

	it('an error an interceptor throws reaches the caller untouched', async () => {
		class AppError extends Error {}
		const thrown = new AppError('file too large');
		const made = setup({ methods: [{ name: 'upload', post: 'u' }], interceptors: { request: () => { throw thrown; } } });
		ti = made.ti;
		assert.equal(await rejection(made.api.upload({ body: {} })), thrown);
		assert.equal(ti.requests.length, 0);
	});

	it('failWhenOffline rejects at once instead of waiting for a timeout', async () => {
		const made = setup({ failWhenOffline: true, methods: [{ name: 'get', get: 'x' }] });
		ti = made.ti;
		ti.Ti.Network.online = false;
		const error = await rejection(made.api.get());
		assert.equal(error.kind, 'network');
		assert.equal(error.isOffline, true);
		assert.equal(ti.requests.length, 0);
		ti.Ti.Network.online = true;
		ti.respond(() => ({ status: 200, body: {} }));
		await made.api.get();
		assert.equal(ti.requests.length, 1);
	});
});
