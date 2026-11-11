'use strict';

const { ResteError } = require('./errors');
const { isFunction, isObject, isPlainObject, getPath } = require('./util');

const PAGE_DEFAULTS = {
	style: 'page',
	pageParam: 'page',
	perPageParam: 'per_page',
	perPage: null,
	firstPage: 1,
	items: null, // where the list is in the body; default: the unwrapped data, or the body when it is an array
	meta: null, // where the paging metadata is; default: the response's meta
	page: 'current_page',
	lastPage: 'last_page',
	total: 'total',
	hasMore: null // path in meta or function (meta, page) -> boolean; default: derived from the fields above
};

const CURSOR_DEFAULTS = {
	style: 'cursor',
	limitParam: 'limit',
	limit: null,
	order: 'asc', // order of the list as held: 'asc' oldest first (a chat), 'desc' newest first (a feed)
	nextParam: 'before', // next() asks for what lies further back, from the oldest item held
	previousParam: 'after', // previous() asks for what is newer than the newest item held
	cursorOf: 'id', // item -> its cursor value (a path or a function)
	cursorParam: null, // token cursors: the parameter that carries the server's cursor ...
	nextCursor: null, // ... and where the body holds the next one (a path or a function of the body)
	previousCursor: null,
	items: null,
	meta: null,
	hasMore: 'has_more'
};

/** 'page', 'cursor', true or an object -> a full pagination config layered over `base`; null when off. */
function normalizePagination(value, base) {
	if (value === undefined || value === null || value === false) {
		return value === false ? null : (base || null);
	}
	let input = value;
	if (value === true) {
		input = { style: (base && base.style) || 'page' };
	} else if (typeof value === 'string') {
		input = { style: value };
	} else if (!isPlainObject(value)) {
		return base || null;
	}
	const style = input.style || (base && base.style) || (input.cursorParam || input.nextParam ? 'cursor' : 'page');
	const defaults = style === 'cursor' ? CURSOR_DEFAULTS : PAGE_DEFAULTS;
	return Object.assign({}, defaults, base && base.style === style ? base : null, input, { style });
}

function number(value) {
	if (value === null || value === undefined || value === '') {
		return null;
	}
	const parsed = Number(value);
	return isNaN(parsed) ? null : parsed;
}

/**
 * Reads one page out of a response: the items and what the server said about paging.
 * `request` is what was asked for ({ page, perPage } or { limit }), used when the server says nothing.
 *
 * @returns {{items: Array, meta: ?object, page: ?number, lastPage: ?number, total: ?number, hasMore: boolean,
 *            nextCursor: *, previousCursor: *}}
 */
function readPage(config, response, request, fallbackItems) {
	const body = response.body;
	let items;
	if (config.items) {
		items = getPath(body, config.items, response);
	} else if (fallbackItems) {
		items = getPath(body, fallbackItems, response);
		if (items === undefined && Array.isArray(body)) {
			items = body;
		}
	} else if (Array.isArray(response.data)) {
		items = response.data;
	} else if (Array.isArray(body)) {
		items = body;
	}
	if (!Array.isArray(items)) {
		throw ResteError('parse', 'RESTe :: no list found in the response of ' + response.endpoint
			+ (config.items || fallbackItems ? ' at "' + (isFunction(config.items || fallbackItems) ? 'items()' : config.items || fallbackItems) + '"' : ''),
		{ status: response.status, body });
	}

	let meta = config.meta ? getPath(body, config.meta, response) : response.meta;
	if (meta === undefined) {
		meta = null;
	}
	const page = { items, meta, page: null, lastPage: null, total: null, hasMore: false, nextCursor: null, previousCursor: null };

	if (config.style === 'cursor') {
		if (config.nextCursor) {
			const next = getPath(body, config.nextCursor, response);
			page.nextCursor = next === undefined ? null : next;
			page.hasMore = page.nextCursor !== null && page.nextCursor !== '';
		} else {
			const flag = isObject(meta) || isFunction(config.hasMore) ? getPath(meta, config.hasMore, page) : undefined;
			if (flag !== undefined && flag !== null) {
				page.hasMore = Boolean(flag);
			} else {
				page.hasMore = request && request.limit ? items.length >= request.limit : items.length > 0;
			}
		}
		if (config.previousCursor) {
			const previous = getPath(body, config.previousCursor, response);
			page.previousCursor = previous === undefined ? null : previous;
		}
		return page;
	}

	const source = isObject(meta) ? meta : null;
	page.page = number(source && getPath(source, config.page));
	page.lastPage = number(source && getPath(source, config.lastPage));
	page.total = number(source && getPath(source, config.total));
	if (page.page === null && request && request.page != null) {
		page.page = request.page;
	}
	const perPage = request && request.perPage;
	if (config.hasMore) {
		page.hasMore = Boolean(getPath(source, config.hasMore, page));
	} else if (page.lastPage !== null) {
		page.hasMore = page.page < page.lastPage;
	} else if (page.total !== null && perPage) {
		page.hasMore = page.page * perPage < page.total;
	} else {
		// The server sent no paging metadata: a full page suggests another one, a short page is the end.
		page.hasMore = perPage ? items.length >= perPage : false;
	}
	return page;
}

/**
 * Walks a paginated endpoint and keeps what the server said about it.
 *
 *   const pager = api.paginate('getJobs', { query: { status: 'open' }, perPage: 20 });
 *   pager.next().then(page => page.items);     // page 1, then 2, ... ; resolves { items: [], done: true } at the end
 *   pager.refresh();                           // the first page again; the list is replaced by it
 *   pager.items, pager.hasMore, pager.page, pager.total, pager.meta, pager.loading
 *
 * Cursor style adds pager.previous() (what is newer than the newest item held).
 *
 * `call(query)` performs the request and returns a handle resolving with the full response; `apply(page,
 * direction)`, when given, puts the page's items somewhere (a collection) and may return a promise. Both can
 * also be given per load: pager.next({ call, apply }).
 */
function createPager(config, options, defaultCall, defaultApply) {
	const settings = options || {};
	const cursor = config.style === 'cursor';
	const size = cursor ? (settings.limit || settings.perPage || config.limit) : (settings.perPage || settings.limit || config.perPage);
	const idOf = settings.idAttribute || (cursor ? config.cursorOf : 'id');

	const pager = {
		style: config.style,
		items: [],
		meta: null,
		page: 0,
		lastPage: null,
		total: null,
		hasMore: true,
		hasPrevious: cursor,
		loaded: false,
		loading: false,
		nextCursor: null,
		previousCursor: null,
		next: hooks => load('next', hooks),
		previous: hooks => load('previous', hooks),
		refresh: hooks => load('refresh', hooks),
		abort,
		reset() {
			abort();
			pager.items = [];
			pager.meta = null;
			pager.page = 0;
			pager.lastPage = pager.total = null;
			pager.hasMore = true;
			pager.hasPrevious = cursor;
			pager.loaded = false;
			pager.nextCursor = pager.previousCursor = null;
		}
	};

	const inflight = { next: null, previous: null, refresh: null };
	let generation = 0; // bumped whenever the list held is thrown away

	function abort() {
		generation++;
		['next', 'previous', 'refresh'].forEach((direction) => {
			const pending = inflight[direction];
			inflight[direction] = null;
			if (pending && pending.handle && isFunction(pending.handle.abort)) {
				pending.handle.abort();
			}
		});
		pager.loading = false;
	}

	function held() {
		return isFunction(settings.held) ? settings.held() : pager.items;
	}

	function cursorValue(item) {
		if (item && isFunction(item.get) && !isFunction(config.cursorOf)) {
			return item.get(config.cursorOf); // a Backbone model
		}
		return getPath(item, config.cursorOf);
	}

	function queryFor(direction) {
		const query = {};
		const request = {};
		if (cursor) {
			if (size) {
				query[config.limitParam] = request.limit = size;
			}
			if (direction === 'refresh') {
				return { query, request };
			}
			if (config.cursorParam) {
				const token = direction === 'next' ? pager.nextCursor : pager.previousCursor;
				if (token != null) {
					query[config.cursorParam] = token;
				}
			} else {
				const list = held();
				if (list.length) {
					const oldestFirst = config.order !== 'desc';
					const edge = (direction === 'next') === oldestFirst ? list[0] : list[list.length - 1];
					query[direction === 'next' ? config.nextParam : config.previousParam] = cursorValue(edge);
				}
			}
			return { query, request };
		}
		request.page = direction === 'next' && pager.loaded ? pager.page + 1 : config.firstPage;
		query[config.pageParam] = request.page;
		if (size) {
			query[config.perPageParam] = request.perPage = size;
		}
		return { query, request };
	}

	function keep(page, direction) {
		if (isFunction(settings.held)) {
			return; // the collection holds the items
		}
		if (direction === 'refresh') {
			pager.items = page.items.slice();
			return;
		}
		const seen = new Set(pager.items.map(item => getPath(item, idOf)));
		const fresh = page.items.filter((item) => {
			const id = getPath(item, idOf);
			if (id === undefined || id === null) {
				return true;
			}
			if (seen.has(id)) {
				return false; // a row inserted on the server shifts the pages, so a page can repeat one
			}
			seen.add(id);
			return true;
		});
		const atStart = cursor && ((direction === 'next') === (config.order !== 'desc'));
		pager.items = atStart ? fresh.concat(pager.items) : pager.items.concat(fresh);
	}

	function load(direction, hooks) {
		const call = (hooks && hooks.call) || defaultCall;
		const apply = (hooks && hooks.apply) || defaultApply;
		if (inflight[direction]) {
			return inflight[direction].promise; // one load per direction at a time
		}
		if (direction === 'previous' && !cursor) {
			return Promise.reject(ResteError('config', 'RESTe :: previous() needs cursor pagination'));
		}
		if (direction === 'next' && pager.loaded && !pager.hasMore) {
			return Promise.resolve({ items: [], meta: pager.meta, hasMore: false, done: true });
		}
		if (direction === 'refresh') {
			abort(); // whatever was loading belongs to the list being replaced
		}
		const mine = generation;
		const built = queryFor(direction);
		let handle;
		try {
			handle = call(built.query);
		} catch (error) {
			return Promise.reject(error);
		}
		const record = { handle, promise: null };
		pager.loading = true;
		const settle = () => {
			if (inflight[direction] === record) {
				inflight[direction] = null;
			}
			pager.loading = Boolean(inflight.next || inflight.previous || inflight.refresh);
		};
		record.promise = handle.then((response) => {
			// `unchanged`: the caller already holds exactly this page (see Collection#refresh); nothing to read.
			const page = response.unchanged
				? { items: [], meta: pager.meta, hasMore: pager.hasMore, unchanged: true }
				: readPage(config, response, built.request, settings.content);
			page.response = response;
			page.direction = direction;
			return Promise.resolve(apply ? apply(page, direction) : null).then((applied) => {
				if (page.unchanged) {
					settle();
					return Object.assign(page, applied || null, { done: !pager.hasMore });
				}
				if (mine !== generation) {
					// A refresh replaced the list while this page was being merged.
					settle();
					return Object.assign(page, { discarded: true });
				}
				keep(page, direction);
				pager.meta = page.meta;
				pager.loaded = true;
				if (cursor) {
					if (direction === 'previous') {
						pager.hasPrevious = page.hasMore;
						if (page.previousCursor !== null) {
							pager.previousCursor = page.previousCursor;
						}
					} else {
						pager.hasMore = page.hasMore;
						pager.nextCursor = page.nextCursor;
						if (direction === 'refresh') {
							pager.previousCursor = page.previousCursor;
							pager.hasPrevious = true;
						}
					}
				} else {
					pager.page = page.page === null ? built.request.page : page.page;
					pager.lastPage = page.lastPage;
					pager.total = page.total;
					pager.hasMore = page.hasMore;
				}
				settle();
				return Object.assign(page, applied || null, { done: !page.hasMore });
			});
		}).then(null, (error) => {
			settle();
			throw error;
		});
		// A page abandoned by refresh() or abort() rejects as cancelled; that is not an unhandled failure.
		record.promise.catch(() => {});
		inflight[direction] = record;
		return record.promise;
	}

	return pager;
}

module.exports = { normalizePagination, readPage, createPager, PAGE_DEFAULTS, CURSOR_DEFAULTS };
