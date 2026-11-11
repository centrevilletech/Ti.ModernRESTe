'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rejection, wait } = require('../helpers/setup');
const { normalizePagination, readPage } = require('../../src/pagination');

let ti;
afterEach(() => ti && ti.uninstall());

const TOTAL = 45;
const all = Array.from({ length: TOTAL }, (unused, index) => ({ id: index + 1, title: 'Item ' + (index + 1) }));

function queryOf(request) {
	return Object.fromEntries(new URL(request.url).searchParams.entries());
}

/** A fake API: /items pages by page/per_page, /messages by before/after ids, /feed by an opaque cursor. */
function serve(request) {
	const url = new URL(request.url);
	const query = queryOf(request);
	if (url.pathname.endsWith('/items')) {
		const perPage = Number(query.per_page || 10);
		const page = Number(query.page || 1);
		return {
			status: 200,
			body: { data: all.slice((page - 1) * perPage, page * perPage), meta: { current_page: page, per_page: perPage, total: TOTAL, last_page: Math.ceil(TOTAL / perPage) } }
		};
	}
	if (url.pathname.endsWith('/messages')) {
		const limit = Number(query.limit || 20);
		if (query.after) {
			const newer = all.filter(item => item.id > Number(query.after));
			return { status: 200, body: { data: newer.slice(0, limit), meta: { has_more: newer.length > limit } } };
		}
		const older = query.before ? all.filter(item => item.id < Number(query.before)) : all;
		return { status: 200, body: { data: older.slice(Math.max(0, older.length - limit)), meta: { has_more: older.length > limit } } };
	}
	if (url.pathname.endsWith('/feed')) {
		const offset = Number(query.cursor || 0);
		const next = offset + 10 < TOTAL ? String(offset + 10) : null;
		return { status: 200, body: { items: all.slice(offset, offset + 10), next_cursor: next } };
	}
	if (url.pathname.endsWith('/bare')) {
		const perPage = Number(query.per_page || 10);
		const page = Number(query.page || 1);
		return { status: 200, body: all.slice((page - 1) * perPage, page * perPage) };
	}
	return { status: 404 };
}

function make(config) {
	const made = setup(Object.assign({
		unwrap: 'data',
		meta: 'meta',
		methods: [
			{ name: 'items', get: 'items', paginate: { style: 'page', perPage: 20 } },
			{ name: 'messages', get: 'rooms/<room>/messages', paginate: { style: 'cursor', limit: 20 } },
			{ name: 'feed', get: 'feed', paginate: { style: 'cursor', cursorParam: 'cursor', nextCursor: 'next_cursor', items: 'items', order: 'desc' } },
			{ name: 'bare', get: 'bare', unwrap: false, paginate: { style: 'page', perPage: 20 } }
		]
	}, config));
	ti = made.ti;
	ti.respond(serve);
	return made;
}

describe('page / per_page pagination', () => {
	it('walks the pages and keeps the server\'s metadata', async () => {
		const { api } = make();
		const pager = api.paginate('items', { query: { status: 'open' } });
		assert.equal(pager.hasMore, true);
		const first = await pager.next();
		assert.equal(first.items.length, 20);
		assert.deepEqual(first.meta, { current_page: 1, per_page: 20, total: 45, last_page: 3 });
		assert.deepEqual([pager.page, pager.lastPage, pager.total, pager.hasMore], [1, 3, 45, true]);
		assert.deepEqual(queryOf(ti.last), { status: 'open', page: '1', per_page: '20' });
		await pager.next();
		const last = await pager.next();
		assert.equal(last.items.length, 5);
		assert.equal(last.done, true);
		assert.deepEqual([pager.page, pager.hasMore, pager.items.length], [3, false, 45]);
		const end = await pager.next();
		assert.deepEqual([end.items.length, end.done], [0, true]);
		assert.equal(ti.requests.length, 3);
	});

	it('refresh() loads the first page again and replaces the list', async () => {
		const { api } = make();
		const pager = api.paginate('items', { perPage: 10 });
		await pager.next();
		await pager.next();
		assert.equal(pager.items.length, 20);
		const page = await pager.refresh();
		assert.equal(queryOf(ti.last).page, '1');
		assert.equal(page.items.length, 10);
		assert.deepEqual([pager.items.length, pager.page, pager.hasMore], [10, 1, true]);
	});

	it('does not repeat a row when the server\'s pages shifted', async () => {
		const { api } = make();
		const pager = api.paginate('items', { perPage: 10 });
		await pager.next();
		// A row was inserted at the top on the server: page 2 now starts with the last row of page 1.
		ti.respond(() => ({ status: 200, body: { data: all.slice(9, 19), meta: { current_page: 2, last_page: 5, total: 46 } } }));
		await pager.next();
		assert.equal(pager.items.length, 19);
		assert.equal(new Set(pager.items.map(item => item.id)).size, 19);
	});

	it('concurrent next() calls share one request', async () => {
		const { api } = make();
		const pager = api.paginate('items');
		const [a, b] = await Promise.all([pager.next(), pager.next()]);
		assert.equal(a, b);
		assert.equal(ti.requests.length, 1);
		assert.equal(pager.loading, false);
	});

	it('refresh() while a page is loading discards that page', async () => {
		const { api } = make();
		const pager = api.paginate('items', { perPage: 10 });
		await pager.next();
		ti.respond(() => null);
		const stale = pager.next();
		ti.respond(serve);
		await pager.refresh();
		assert.equal((await rejection(stale)).kind, 'cancelled');
		assert.deepEqual([pager.items.length, pager.page], [10, 1]);
	});

	it('guesses the end from a short page when the server sends no metadata', async () => {
		const { api } = make();
		const pager = api.paginate('bare');
		await pager.next();
		assert.deepEqual([pager.hasMore, pager.page], [true, 1]);
		await pager.next();
		await pager.next();
		assert.deepEqual([pager.hasMore, pager.items.length, pager.page], [false, 45, 3]);
	});

	it('reads items and metadata from wherever the API puts them', async () => {
		const { api } = make({
			unwrap: undefined,
			meta: undefined,
			methods: [{
				name: 'odd', get: 'odd', paginate: {
					style: 'page', pageParam: 'p', perPageParam: 'size', perPage: 2, firstPage: 0,
					items: 'result.rows', meta: body => body.result.paging, page: 'index', lastPage: 'last', total: 'count'
				}
			}]
		});
		ti.respond(request => ({ status: 200, body: { result: { rows: [{ id: 1 }, { id: 2 }], paging: { index: Number(queryOf(request).p), last: 4, count: 10 } } } }));
		const pager = api.paginate('odd');
		const page = await pager.next();
		assert.deepEqual(queryOf(ti.last), { p: '0', size: '2' });
		assert.equal(page.items.length, 2);
		assert.deepEqual([pager.page, pager.lastPage, pager.total, pager.hasMore], [0, 4, 10, true]);
		await pager.next();
		assert.equal(queryOf(ti.last).p, '1');
	});

	it('rejects with a parse error when there is no list where one should be', async () => {
		const { api } = make();
		ti.respond(() => ({ status: 200, body: { data: { not: 'a list' } } }));
		const error = await rejection(api.paginate('items').next());
		assert.equal(error.kind, 'parse');
	});

	it('plain calls of a paginated method still resolve the items and can return the metadata', async () => {
		const { api } = make();
		const items = await api.items({ query: { page: 2, per_page: 5 } });
		assert.deepEqual(items.map(item => item.id), [6, 7, 8, 9, 10]);
		const response = await api.items({ query: { page: 2, per_page: 5 } }, { fullResponse: true });
		assert.equal(response.meta.last_page, 9);
	});
});

describe('cursor pagination', () => {
	it('before/after ids: next() goes back in history, previous() asks for what is new', async () => {
		const { api } = make();
		const pager = api.paginate('messages', { params: { room: 'r1' } });
		const first = await pager.next();
		assert.deepEqual([first.items[0].id, first.items[19].id], [26, 45]);
		assert.deepEqual(queryOf(ti.last), { limit: '20' });
		assert.equal(ti.last.url.indexOf('https://api.test/v1/rooms/r1/messages?'), 0);
		await pager.next();
		assert.deepEqual(queryOf(ti.last), { limit: '20', before: '26' });
		assert.deepEqual([pager.items[0].id, pager.items.length, pager.hasMore], [6, 40, true]);
		await pager.next();
		assert.deepEqual([pager.items[0].id, pager.items.length, pager.hasMore], [1, 45, false]);
		all.push({ id: 46, title: 'new' });
		try {
			const newer = await pager.previous();
			assert.deepEqual(queryOf(ti.last), { limit: '20', after: '45' });
			assert.deepEqual(newer.items.map(item => item.id), [46]);
			assert.equal(pager.items[pager.items.length - 1].id, 46);
			assert.equal(pager.hasPrevious, false);
		} finally {
			all.pop();
		}
	});

	it('opaque cursor tokens are passed back as the server gave them', async () => {
		const { api } = make();
		const pager = api.paginate('feed');
		await pager.next();
		assert.deepEqual(queryOf(ti.last), {});
		assert.equal(pager.nextCursor, '10');
		await pager.next();
		assert.deepEqual(queryOf(ti.last), { cursor: '10' });
		while (pager.hasMore) {
			await pager.next();
		}
		assert.equal(pager.items.length, 45);
		assert.equal(pager.nextCursor, null);
	});

	it('previous() needs cursor pagination', async () => {
		const { api } = make();
		assert.equal((await rejection(api.paginate('items').previous())).kind, 'config');
	});

	it('abort() cancels what is loading', async () => {
		const { api } = make();
		ti.respond(() => null);
		const pager = api.paginate('messages', { params: { room: 1 } });
		const loading = pager.next();
		pager.abort();
		assert.equal((await rejection(loading)).kind, 'cancelled');
		assert.equal(ti.last.aborted, true);
		await wait();
	});
});

describe('pagination settings', () => {
	it('normalise from strings, true and objects, over global defaults', () => {
		assert.equal(normalizePagination(undefined), null);
		assert.equal(normalizePagination(false), null);
		assert.equal(normalizePagination('cursor').limitParam, 'limit');
		assert.equal(normalizePagination(true).pageParam, 'page');
		const base = normalizePagination({ style: 'page', perPageParam: 'size', perPage: 25 });
		assert.deepEqual([normalizePagination(true, base).perPageParam, normalizePagination({ perPage: 5 }, base).perPage], ['size', 5]);
		assert.equal(normalizePagination({ cursorParam: 'c' }).style, 'cursor');
	});

	it('global pagination defaults apply to every paginated method', async () => {
		const { api } = make({ pagination: { style: 'page', pageParam: 'p', perPageParam: 'n', perPage: 7 }, methods: [{ name: 'items', get: 'items', paginate: true }] });
		await api.paginate('items').next();
		assert.deepEqual(queryOf(ti.last), { p: '1', n: '7' });
	});

	it('readPage accepts a custom hasMore', () => {
		const config = normalizePagination({ style: 'page', hasMore: meta => meta.more === 'yes' });
		const page = readPage(config, { body: { data: [1], meta: { more: 'yes' } }, data: [1], meta: { more: 'yes' }, endpoint: 'x' }, { page: 1 });
		assert.equal(page.hasMore, true);
	});
});
