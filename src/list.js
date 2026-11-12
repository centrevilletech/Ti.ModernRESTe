'use strict';

const { createPager, readPage } = require('./pagination');
const { createAbortController, watchSignal } = require('./abort');
const { isFunction } = require('./util');

/**
 * A list that follows a collection.
 *
 * Apps often keep one collection per resource as the place where every model of that resource lives, and
 * show several lists of it: "open jobs", "my jobs", one conversation's messages. Such a list is an ordered
 * selection of the collection's models:
 *
 *   const open = api.list({
 *       collection: 'jobs',                                   // or the collection itself
 *       method: 'getJobs',                                    // default: the collection's read method
 *       query: { status: 'open' },                            // sent with every page
 *       filter: model => model.get('status') === 'open'       // which models of the collection belong
 *   });
 *   open.on('change', render);        // membership, order or a member's attributes changed: once per turn
 *   open.on('state', showSpinner);    // 'idle' | 'loading' | 'refreshing' | 'loadingMore' | 'error'
 *   open.load();                      // what the collection already holds at once, then the first page
 *   open.loadMore();  open.refresh();  open.retry();  open.reload({ query, filter });  open.destroy();
 *   open.models()                     // the models, in order
 *
 * Pages are merged into the collection (nothing is removed from it) and decide the order. A model that
 * reaches the collection another way (a socket event, an optimistic create, another list's page) joins the
 * list when it passes `filter`, at `place` ('start' or 'end'); one that stops passing it, or leaves the
 * collection, drops out. When a later page brings a model that had joined, it takes its place in the page.
 *
 * A page speaks for the list as it was when the page was asked for. A row that got into the list after
 * that (it joined, or a page asked for later brought it) is not the page's to drop: it stays at `place`
 * until a page asked for after it got here has it or does not. The same holds for a row the device is
 * still creating, and a member the device changed so that it left the list is not put back by a page
 * while that change is unanswered.
 *
 * Cursor pagination adds loadOlder() (= loadMore) and loadNewer().
 *
 * deps: { Events, collection, pagination, content, request(params, query, signal) -> handle,
 *         merge(items) -> result, track(promise) }
 */
function createLiveList(deps, options) {
	const collection = deps.collection;
	const pagination = deps.pagination;
	const cursor = Boolean(pagination && pagination.style === 'cursor');
	const oldestFirst = cursor && pagination.order !== 'desc';
	const place = options.place || (oldestFirst ? 'end' : 'start');
	const schedule = isFunction(options.schedule) ? options.schedule : run => Promise.resolve().then(run);
	const controller = createAbortController();

	const list = Object.assign({}, deps.Events);
	let filter = options.filter || (() => true);
	let params = options.params;
	let query = options.query;
	let members = [];
	let memberSet = new Set();
	let joined = new Set(); // members that came from the collection, not from a page
	const since = new WeakMap(); // model -> `clock` when it got into the list (a page's rows: when it was asked for)
	let clock = 0; // moves with every request sent and every row that joins
	let early = []; // rows that reached the collection while the first page was out: they join when it lands
	let state = 'idle';
	let error = null;
	let loaded = false;
	let failedMore = false;
	let changeQueued = false;
	let destroyed = false;
	let generation = 0;
	let single = null; // the request in flight of a list without pagination

	const asked = {}; // direction -> `clock` when the request that is out was sent
	const pager = pagination ? createPager(pagination, {
		perPage: options.perPage,
		limit: options.limit,
		content: deps.content,
		held: () => members.filter(model => !model._pendingCreate) // a cursor is a row the server has seen
	}, (pageQuery, direction) => {
		asked[direction] = ++clock;
		return deps.request(params, Object.assign({}, query, pageQuery), controller.signal);
	}, (page, direction) => {
		page.asked = asked[direction];
		return page.unchanged ? null : mergePage(page.items);
	}) : null;

	// While one of this list's own pages is being merged into the collection, what the collection announces
	// is held: the page decides where its models go, and only what came from elsewhere joins on its own.
	let applying = 0;
	let held = [];
	let pageModels = new Set();

	function mergePage(items) {
		applying++;
		const finish = (models) => {
			models.forEach(model => pageModels.add(model));
			if (--applying > 0) {
				return;
			}
			const pending = held;
			const fromPages = pageModels;
			held = [];
			pageModels = new Set();
			pending.forEach((entry) => {
				if (!fromPages.has(entry.model)) {
					entry.handle(entry.model);
				}
			});
		};
		let result;
		try {
			result = deps.merge(items);
		} catch (failure) {
			finish([]);
			throw failure;
		}
		return Promise.resolve(result).then((merged) => {
			finish(merged.models);
			return merged;
		}, (failure) => {
			finish([]);
			throw failure;
		});
	}

	function inCollection(model) {
		if (model.id != null) {
			return collection.get(model.id) === model;
		}
		return (isFunction(collection.getByCid) ? collection.getByCid(model.cid) : collection.get(model.cid)) === model;
	}

	function setMembers(next) {
		members = next;
		memberSet = new Set(next);
	}

	/** One "change" per turn however many models moved. */
	function changed() {
		if (changeQueued || destroyed) {
			return;
		}
		changeQueued = true;
		schedule(() => {
			changeQueued = false;
			if (!destroyed) {
				list.trigger('change', list);
			}
		});
	}

	function setState(next, nextError) {
		state = next;
		error = nextError || null;
		list.trigger('state', state, list);
	}

	/** A change of the device's that the server has not answered yet (model.optimistic(), an optimistic save). */
	function changing(model) {
		const pending = model._pendingAttrs;
		return Boolean(pending) && Object.keys(pending).length > 0;
	}

	/**
	 * Puts a page into the list. `sent` is the clock when the page was asked for: the page speaks for the
	 * list as it was then.
	 */
	function show(models, how, sent) {
		const unique = [];
		const incoming = new Set();
		models.forEach((model) => {
			// A member the device changed so that it left the list: the page was made before that change.
			if (!incoming.has(model) && !(changing(model) && !filter(model))) {
				incoming.add(model);
				unique.push(model);
			}
		});
		// Not this page's to place or to drop: a row the device is still creating, and one that got here
		// after the page was asked for.
		const beyond = model => Boolean(model._pendingCreate) || since.get(model) > sent;
		if (how === 'replace') {
			const waiting = early.filter(model => !memberSet.has(model) && filter(model) && inCollection(model));
			const stay = members.concat(waiting).filter(model => !incoming.has(model) && beyond(model));
			joined = new Set(stay);
			early = [];
			setMembers(place === 'start' ? stay.concat(unique) : unique.concat(stay));
		} else {
			// A page brings a model that had joined on its own: it takes its place in the page.
			const kept = members.filter(model => !(joined.has(model) && incoming.has(model)));
			unique.forEach(model => joined.delete(model));
			const have = new Set(kept);
			const fresh = unique.filter(model => !have.has(model));
			// The page goes next to what the list held when it was asked for: rows that got to that end
			// since then stay beyond it.
			let edge = how === 'start' ? 0 : kept.length;
			if (how === 'start') {
				while (edge < kept.length && beyond(kept[edge])) {
					edge++;
				}
			} else {
				while (edge > 0 && beyond(kept[edge - 1])) {
					edge--;
				}
			}
			setMembers(kept.slice(0, edge).concat(fresh, kept.slice(edge)));
		}
		unique.forEach((model) => {
			if (!(since.get(model) > sent)) {
				since.set(model, sent);
			}
		});
		loaded = true;
		changed();
	}

	function insert(model, settings) {
		if (memberSet.has(model)) {
			return;
		}
		const at = settings && settings.at != null ? settings.at : (place === 'start' ? 0 : members.length);
		const next = members.slice();
		next.splice(Math.max(0, Math.min(at, next.length)), 0, model);
		setMembers(next);
		joined.add(model);
		since.set(model, ++clock);
		changed();
	}

	/** A model the collection got on its own: into the list, or kept for the first page that is on its way. */
	function join(model) {
		if (loaded) {
			insert(model);
		} else if (state === 'loading' && early.indexOf(model) === -1) {
			early.push(model);
			since.set(model, ++clock);
		}
	}

	function remove(target) {
		const model = target && target.cid !== undefined ? target : members.find(member => member.id === target);
		if (!model || !memberSet.has(model)) {
			return;
		}
		setMembers(members.filter(member => member !== model));
		joined.delete(model);
		changed();
	}

	function onAdd(model) {
		if (applying) {
			held.push({ model, handle: onAdd });
			return;
		}
		if (model && filter(model)) {
			join(model);
		}
	}

	function onChange(model) {
		if (!model || model.cid === undefined) {
			return;
		}
		if (applying) {
			held.push({ model, handle: onChange });
			return;
		}
		const member = memberSet.has(model);
		if (member && !filter(model)) {
			remove(model);
		} else if (!member && filter(model) && inCollection(model)) {
			join(model);
		} else if (member) {
			changed(); // a member's attributes: the screen updates that row
		}
	}

	function onReset() {
		setMembers(members.filter(inCollection));
		changed();
	}

	/** RESTe's merges announce themselves once, with what they added, removed and changed. */
	function onUpdate(target, details) {
		const changes = details && details.changes;
		if (!changes) {
			return;
		}
		(changes.removed || []).forEach(remove);
		(changes.added || []).forEach(onAdd);
		(changes.merged || []).forEach(onChange);
	}

	collection.on('add', onAdd);
	collection.on('remove', remove);
	collection.on('reset', onReset);
	collection.on('change', onChange);
	collection.on('update', onUpdate);

	function settle(promise, how, more) {
		const mine = generation;
		failedMore = false;
		const landed = promise.then((page) => {
			if (destroyed || mine !== generation || page.discarded) {
				return page;
			}
			if (page.response && !page.unchanged) {
				show(page.models || [], how, page.asked);
				list.meta = page.meta;
			} else if (!loaded) {
				loaded = true;
				changed();
			}
			setState('idle');
			return page;
		}, (failure) => {
			if (destroyed || mine !== generation || (failure && failure.isCancelled)) {
				return null;
			}
			failedMore = Boolean(more);
			setState('error', failure);
			list.trigger('error', failure, list);
			return null;
		});
		if (deps.track) {
			// Optimistic writes stay protected until this load has landed: in the collection, and here, so
			// the page above still sees which rows the device is creating.
			deps.track(landed);
		}
		return landed;
	}

	function loadSingle() {
		if (single) {
			single.abort();
		}
		const sent = ++clock;
		const handle = single = deps.request(params, Object.assign({}, query), controller.signal);
		return handle.then((response) => {
			const page = readPage({ style: 'page', items: null, meta: null }, response, null, deps.content);
			page.response = response;
			page.asked = sent;
			return mergePage(page.items).then(result => Object.assign(page, result));
		});
	}

	function refresh() {
		if (destroyed) {
			return Promise.resolve(null);
		}
		setState(members.length ? 'refreshing' : 'loading');
		return settle(pager ? pager.refresh() : loadSingle(), 'replace', false);
	}

	function loadMore() {
		if (destroyed || !pager || !loaded || (state !== 'idle' && state !== 'error') || !pager.hasMore) {
			return Promise.resolve(null);
		}
		setState('loadingMore');
		return settle(pager.next(), oldestFirst ? 'start' : 'end', true);
	}

	function loadNewer() {
		if (!cursor || !loaded) {
			return refresh();
		}
		return settle(pager.previous(), oldestFirst ? 'end' : 'start', false);
	}

	function cached() {
		return isFunction(options.cached) ? options.cached() : collection.filter(filter);
	}

	function destroy() {
		if (destroyed) {
			return;
		}
		destroyed = true;
		controller.abort();
		collection.off('add', onAdd);
		collection.off('remove', remove);
		collection.off('reset', onReset);
		collection.off('change', onChange);
		collection.off('update', onUpdate);
		list.off();
	}

	if (options.signal) {
		if (options.signal.aborted) {
			destroy();
		} else {
			watchSignal(options.signal, destroy);
		}
	}

	Object.defineProperties(list, {
		state: { get: () => state },
		error: { get: () => error },
		loaded: { get: () => loaded },
		/** True when the last failure was a further page: the rows stay, a retry row goes under them. */
		failedMore: { get: () => state === 'error' && failedMore },
		total: { get: () => (pager ? pager.total : null) },
		length: { get: () => members.length }
	});

	return Object.assign(list, {
		meta: null,
		/** Shows what the collection already holds, then loads the first page. */
		load() {
			const initial = cached();
			if (initial.length && !loaded) {
				joined = new Set();
				setMembers(initial.slice());
				loaded = true;
				changed();
			}
			return refresh();
		},
		refresh,
		loadMore,
		loadOlder: loadMore,
		loadNewer,
		/** After an error: what failed, again. */
		retry() {
			return failedMore ? loadMore() : refresh();
		},
		/** Other filters: forgets the pages and loads again, showing what the collection holds meanwhile. */
		reload(next) {
			const settings = next || {};
			generation++;
			filter = settings.filter || filter;
			params = settings.params !== undefined ? settings.params : params;
			query = settings.query !== undefined ? settings.query : query;
			if (pager) {
				pager.reset();
			}
			setMembers([]);
			joined = new Set();
			early = [];
			loaded = false;
			return list.load();
		},
		insert,
		remove,
		models: () => members.slice(),
		hasMore: () => (pager ? pager.hasMore : false),
		isEmpty: () => loaded && members.length === 0 && state !== 'loading',
		destroy
	});
}

module.exports = { createLiveList };
