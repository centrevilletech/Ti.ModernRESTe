/*!
 * RESTe 2.0.0
 * A JavaScript REST / API helper for Titanium with Alloy Models/Collections support.
 *
 * Copyright Jason Kneen
 * Modifications Copyright 2026 Centreville Tech LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * This file is a modified version of RESTe (https://github.com/jasonkneen/RESTe).
 * It is generated from src/ by scripts/build.js: edit the sources, not this file.
 */
'use strict';

// The second file of the two-file build: reste.js, next to it, reads it on first use. Not for use on its own.
module.exports = {
	"./identity": function (module, exports, require) {
		/**
		 * One model instance per id.
		 *
		 * Where the JavaScript engine has WeakRef the map holds its models weakly: a model stays as long as anything
		 * else holds it (a collection, a screen), and is forgotten when nothing does. Without WeakRef it holds them
		 * strongly and, past `limit`, drops the oldest ones that no collection holds (`held(model)`).
		 *
		 * options: { weak (default: when available), limit (default 1000), held(model) -> boolean }
		 */
		function createIdentityMap(options) {
			const settings = options || {};
			const weak = settings.weak !== false && typeof WeakRef === 'function';
			const limit = settings.limit > 0 ? settings.limit : 1000;
			const held = settings.held || (() => false);
			const map = new Map(); // id -> model, or a WeakRef to it
			let writes = 0;

			function read(id) {
				const value = map.get(id);
				if (value === undefined) {
					return undefined;
				}
				if (!weak) {
					return value;
				}
				const model = value.deref();
				if (model === undefined) {
					map.delete(id);
				}
				return model;
			}

			/** Weak mode: forget the ids whose model is gone. */
			function sweep() {
				map.forEach((value, id) => {
					if (value.deref() === undefined) {
						map.delete(id);
					}
				});
			}

			/** Strong mode: back under the limit by dropping the oldest models that no collection holds. */
			function trim() {
				const ids = Array.from(map.keys());
				for (let i = 0; i < ids.length && map.size > limit; i++) {
					if (!held(map.get(ids[i]))) {
						map.delete(ids[i]);
					}
				}
			}

			return {
				weak,
				get: read,
				has: id => read(id) !== undefined,
				set(id, model) {
					map.delete(id);
					map.set(id, weak ? new WeakRef(model) : model);
					writes++;
					if (weak) {
						if (writes % 512 === 0) {
							sweep();
						}
					} else if (map.size > limit) {
						trim();
					}
				},
				delete: id => map.delete(id),
				clear: () => map.clear(),
				get size() {
					if (weak) {
						sweep();
					}
					return map.size;
				}
			};
		}

		module.exports = { createIdentityMap };
	},
	"./list": function (module, exports, require) {
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
	},
	"./merge": function (module, exports, require) {
		const { isFunction, later } = require('./util');
		const { diffAttributes } = require('./attributes');
		const { ResteError } = require('./errors');

		function holds(collection, model) {
			if (model.id != null) {
				return collection.get(model.id) === model;
			}
			return (isFunction(collection.getByCid) ? collection.getByCid(model.cid) : collection.get(model.cid)) === model;
		}

		/**
		 * Events that RESTe collections hold back while a merge runs, so a list bound to the collection is rendered
		 * once per merge instead of once per row.
		 */
		function isCoalesced(name) {
			return name === 'add' || name === 'remove' || name === 'change' || name === 'sort' || name === 'update'
				|| name === 'reset' || (typeof name === 'string' && name.indexOf('change:') === 0);
		}

		/** The record of what changed in one collection while events were held back. */
		function touch(dirty, collection) {
			let entry = dirty.get(collection);
			if (!entry) {
				entry = { added: new Set(), removed: new Set(), merged: new Set() };
				dirty.set(collection, entry);
			}
			return entry;
		}

		/**
		 * Merging API items into Backbone collections without rebuilding them. Works on every Backbone version Alloy
		 * ships (0.9.2 has no Collection#set), so it does not use Backbone's own merge.
		 *
		 * `batch` is shared by all collections of one RESTe instance: { depth, dirty }, where dirty maps each
		 * collection that held an event back to what changed in it.
		 */
		function createMerger(batch) {
			/**
			 * settings: Model, idAttribute, mirrorId, identity (Map or null), mode ('merge' | 'replace'),
			 *           position ('end' | 'start'), chunk, events ('coalesce' | 'each'), changeEvent, isStale(),
			 *           arrived(model) (replace: true for a model that got here after the list was asked for)
			 * @returns {{models: Array, added: Array, changed: Array, removed: Array}|Promise}
			 */
			function upsert(collection, items, settings) {
				const Model = settings.Model || collection.model;
				const idAttribute = settings.idAttribute || 'id';
				const sourceId = settings.sourceId || idAttribute;
				const mirror = Boolean(settings.mirrorId) && sourceId !== idAttribute;
				const destroying = settings.destroying && settings.destroying.size ? settings.destroying : null;
				const identity = settings.identity || null;
				const replace = settings.mode === 'replace';
				const coalesce = settings.events !== 'each';
				const atStart = settings.position === 'start';
				const job = { models: [], added: [], changed: [], removed: [], dirty: new Map(), insertAt: 0, reordered: false };
				const receivedAt = Date.now();
				const pending = new Map(); // id (or cid) -> model seen in this merge and not in the collection yet

				function begin() {
					if (coalesce) {
						batch.depth++;
					}
				}

				function end() {
					if (coalesce && --batch.depth === 0) {
						carry(batch.dirty, job.dirty);
						batch.dirty.clear();
					}
				}

				function carry(from, to) {
					from.forEach((entry, touched) => {
						const target = touch(to, touched);
						entry.added.forEach(model => target.added.add(model));
						entry.removed.forEach(model => target.removed.add(model));
						entry.merged.forEach(model => target.merged.add(model));
					});
				}

				function find(id) {
					if (id == null) {
						return undefined;
					}
					return collection.get(id) || pending.get(id) || (identity ? identity.get(id) : undefined);
				}

				function slice(from, to) {
					const toAdd = [];
					begin();
					try {
						for (let i = from; i < to; i++) {
							let attrs = items[i];
							let model;
							if (attrs && attrs.cid !== undefined && isFunction(attrs.get)) {
								// A model instance: fold it into the one already known for its id.
								const known = find(attrs.id);
								if (known && known !== attrs) {
									const diff = diffAttributes(known.attributes, attrs.attributes);
									if (diff) {
										known.set(diff);
										job.changed.push(known);
									}
									model = known;
								} else {
									model = attrs;
								}
							} else {
								if (mirror && attrs.id === undefined && attrs[sourceId] != null) {
									attrs = Object.assign({ id: attrs[sourceId] }, attrs);
								}
								if (destroying && destroying.has(attrs[idAttribute])) {
									continue; // being deleted on the device: this response was asked for before that
								}
								model = find(attrs[idAttribute]);
								if (model) {
									const diff = diffAttributes(model.attributes, attrs, model._pendingAttrs);
									if (diff) {
										model.set(diff);
										job.changed.push(model);
									}
								} else {
									model = new Model(attrs);
								}
							}
							if (identity && model.id != null && !identity.has(model.id)) {
								identity.set(model.id, model);
							}
							model.receivedAt = receivedAt; // when the server last sent this model
							job.models.push(model);
							const key = model.id != null ? model.id : model.cid;
							if (!pending.has(key) && !holds(collection, model)) {
								pending.set(key, model); // a second item with this id merges into this model
								if (!replace) {
									// (A replace settles membership and order once, at the end.)
									toAdd.push(model);
									job.added.push(model);
								}
							}
						}
						if (toAdd.length) {
							const options = {};
							if (coalesce) {
								options.silent = true;
							}
							if (atStart) {
								options.at = job.insertAt;
								job.insertAt += toAdd.length;
							}
							collection.add(toAdd, options);
							toAdd.forEach(model => pending.delete(model.id != null ? model.id : model.cid));
						}
					} finally {
						end();
					}
				}

				function settleReplace() {
					const desired = [];
					const wanted = new Set();
					const gone = settings.destroying && settings.destroying.size ? settings.destroying : null;
					job.models.forEach((model) => {
						// (A model whose optimistic destroy began while this merge was running stays out.)
						if (!wanted.has(model) && !(gone && gone.has(model.id))) {
							wanted.add(model);
							desired.push(model);
						}
					});
					job.models = desired.slice();
					const current = collection.models;
					// A model that was created on the device and is still being sent is not in the server's list
					// yet, and neither is one that got here after the list was asked for: it keeps its place.
					const arrived = settings.arrived || (() => false);
					current.forEach((model, index) => {
						if ((model._pendingCreate || arrived(model)) && !wanted.has(model)) {
							wanted.add(model);
							desired.splice(Math.min(index, desired.length), 0, model);
						}
					});
					const had = new Set(current);
					job.removed = current.filter(model => !wanted.has(model));
					job.added = desired.filter(model => !had.has(model));
					const membership = job.removed.length > 0 || job.added.length > 0;
					let order = false;
					if (!collection.comparator && !membership) {
						for (let i = 0; i < desired.length; i++) {
							if (current[i] !== desired[i]) {
								order = true;
								break;
							}
						}
					}
					if (!membership && !order) {
						if (collection.comparator && job.changed.length) {
							collection.sort({ silent: coalesce });
							job.reordered = true;
						}
						return;
					}
					begin();
					try {
						if (coalesce) {
							// The same model instances go back in, in the server's order; nothing is rebuilt.
							collection.reset(desired, { silent: true });
						} else {
							if (job.removed.length) {
								collection.remove(job.removed);
							}
							if (job.added.length) {
								collection.add(job.added);
							}
							if (!collection.comparator) {
								collection.reset(desired, { silent: true });
								collection.trigger('sort', collection, {});
							}
						}
						job.reordered = order || membership;
					} finally {
						end();
					}
				}

				function finalize() {
					if (replace) {
						settleReplace();
					} else if (collection.comparator && job.changed.length && !job.added.length) {
						begin();
						try {
							collection.sort({ silent: coalesce });
						} finally {
							end();
						}
					}
					const touched = job.added.length > 0 || job.removed.length > 0 || job.changed.length > 0 || job.reordered;
					const result = { models: job.models, added: job.added, changed: job.changed, removed: job.removed, touched };
					if (!coalesce) {
						return result;
					}
					if (touched) {
						const own = touch(job.dirty, collection);
						job.added.forEach(model => own.added.add(model));
						job.removed.forEach(model => own.removed.add(model));
						job.changed.forEach(model => own.merged.add(model));
					}
					if (batch.depth > 0) {
						// Inside another merge: that one announces the change.
						carry(job.dirty, batch.dirty);
						return result;
					}
					// One "update" with what changed and one render event per collection that was touched: the one
					// merged into, and any other that holds a model this merge changed.
					const changeEvent = settings.changeEvent || 'fetch';
					job.dirty.forEach((entry, dirty) => {
						dirty.trigger('update', dirty, {
							reste: true,
							changes: { added: Array.from(entry.added), removed: Array.from(entry.removed), merged: Array.from(entry.merged) }
						});
						dirty.trigger(changeEvent, dirty, { reste: true });
					});
					return result;
				}

				const chunk = settings.chunk > 0 ? settings.chunk : 0;
				if (!chunk || items.length <= chunk) {
					slice(0, items.length);
					return finalize();
				}
				return new Promise((resolve, reject) => {
					let index = 0;
					const step = () => {
						if (settings.isStale && settings.isStale()) {
							reject(ResteError('stale', 'RESTe :: the session ended while a list was being merged'));
							return;
						}
						try {
							slice(index, Math.min(index + chunk, items.length));
							index += chunk;
							if (index < items.length) {
								later(step, 0); // let the UI thread breathe between chunks
							} else {
								resolve(finalize());
							}
						} catch (error) {
							reject(error);
						}
					};
					// The first chunk waits a turn as well: the response was parsed just before this, and that is
					// already the longest thing this request does in one go.
					later(step, 0);
				});
			}

			return { upsert };
		}

		module.exports = { createMerger, diffAttributes, isCoalesced, touch };
	},
	"./pagination": function (module, exports, require) {
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
		 * `call(query, direction)` performs the request and returns a handle resolving with the full response;
		 * `apply(page, direction)`, when given, puts the page's items somewhere (a collection) and may return a
		 * promise. Both can also be given per load: pager.next({ call, apply }).
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
					handle = call(built.query, direction);
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
	},
	"./sync": function (module, exports, require) {
		const { ResteError } = require('./errors');
		const { diffAttributes, replaceAttributes } = require('./attributes');
		const { createMerger, isCoalesced, touch } = require('./merge');
		const { createLiveList } = require('./list');
		const { createIdentityMap } = require('./identity');
		const { normalizePagination, createPager, readPage } = require('./pagination');
		const { isFunction, isObject, isPlainObject, has, noop, getPath, deepEqual, hashString } = require('./util');

		const notAborted = () => false;

		/** Options of fetch / save / destroy that are passed on to the request. */
		const CALL_OPTIONS = ['headers', 'timeout', 'signal', 'retry', 'cache', 'force', 'dedupe', 'deadline', 'idempotencyKey',
			'action', 'onProgress', 'meta'];

		/**
		 * Models and collections on top of the request methods.
		 *
		 * Every model class and collection made here carries its own `sync`; `Backbone.sync` is never replaced, so
		 * other models in the app (SQLite, properties, another RESTe instance) are not affected.
		 */
		function createData(reste, state) {
			const batch = { depth: 0, dirty: new Map() };
			const merger = createMerger(batch);
			const records = Object.create(null); // model name -> { config, Model, idAttribute, sourceId, mirrorId, identity, ... }
			const collections = Object.create(null); // collection name -> collection

			// List loads in flight. An optimistic write keeps its protection until every load that was asked for
			// before the server answered the write has landed: such a load may still carry the old state.
			const activeLoads = new Set();
			let loadWaiters = [];

			function trackLoad(promise) {
				const token = {};
				activeLoads.add(token);
				const landed = () => {
					activeLoads.delete(token);
					const ready = [];
					loadWaiters = loadWaiters.filter((waiter) => {
						waiter.pending.delete(token);
						if (waiter.pending.size === 0) {
							ready.push(waiter.run);
							return false;
						}
						return true;
					});
					ready.forEach(run => run());
				};
				promise.then(landed, landed);
				return promise;
			}

			function whenLoadsLanded(run) {
				if (activeLoads.size === 0) {
					run();
				} else {
					loadWaiters.push({ pending: new Set(activeLoads), run });
				}
			}

			function backbone() {
				const found = state.config.Backbone
					|| (typeof Backbone !== 'undefined' ? Backbone : null)  
					|| (typeof Alloy !== 'undefined' && Alloy.Backbone ? Alloy.Backbone : null);  
				if (!found) {
					throw new Error('RESTe :: models and collections need Backbone (Alloy provides it; or pass config.Backbone)');
				}
				return found;
			}

			/** Backbone 0.9.x: no Collection#set, no "request" event, fetch does not trigger "sync". */
			function isLegacy() {
				return /^0\./.test(String(backbone().VERSION || ''));
			}

			function alloy() {
				return typeof Alloy !== 'undefined' ? Alloy : null;  
			}

			function callOptions(options, extra) {
				const out = { fullResponse: true };
				for (let i = 0; i < CALL_OPTIONS.length; i++) {
					if (options[CALL_OPTIONS[i]] !== undefined) {
						out[CALL_OPTIONS[i]] = options[CALL_OPTIONS[i]];
					}
				}
				return extra ? Object.assign(out, extra) : out;
			}

			/** A promise that carries the request's abort(), and never reports "unhandled" for Backbone-style callers. */
			function derive(handle, onFulfilled, onRejected) {
				const result = handle.then(onFulfilled, onRejected);
				result.abort = result.cancel = handle.abort || notAborted;
				result.idempotencyKey = handle.idempotencyKey || null;
				result.catch(noop);
				return result;
			}

			function rejected(error, options, target) {
				const handle = Promise.reject(error);
				handle.catch(noop);
				handle.abort = handle.cancel = notAborted;
				Promise.resolve().then(() => {
					if (options && isFunction(options.error)) {
						options.error(error);
					} else if (target && isLegacy()) {
						target.trigger('error', target, error, options);
					}
				});
				return handle;
			}

			/**
			 * 1.x kept Backbone's id in `id` and copied the configured attribute (`objectId`, say) into it for
			 * everything the server sent. Attributes that only have the configured one get `id` here.
			 */
			function mirrored(record, attrs) {
				if (record.mirrorId && isPlainObject(attrs) && attrs.id === undefined && attrs[record.sourceId] != null) {
					return Object.assign({ id: attrs[record.sourceId] }, attrs);
				}
				return attrs;
			}

			// ------------------------------------------------------------------ models

			function modelData(record, response) {
				const config = record.config;
				const body = response.body;
				let data = response.data;
				if (config.content && isObject(body)) {
					const inner = getPath(body, config.content, response);
					if (inner !== undefined) {
						data = inner;
					}
				}
				if (Array.isArray(data)) {
					data = data.length ? data[0] : null; // upstream: a one-element array is the model
				}
				return isPlainObject(data) ? mirrored(record, data) : null;
			}

			function payload(record, attrs) {
				const body = Object.assign({}, attrs);
				if (record.mirrorId) {
					delete body.id;
				}
				delete body[record.sourceId];
				return body;
			}

			function modelSync(record, method, model, options) {
				const config = record.config;
				const settings = options || {};
				const params = {};
				let methodName;
				if (model.id != null) {
					params[record.sourceId] = model.id;
					params.id = model.id;
				}
				if (method === 'create' && model.id != null) {
					method = 'update'; // upstream: a model that already has an id is updated
				}

				if (method === 'read') {
					methodName = config.read;
					// Upstream passed the fetch options as parameters; path placeholders are still read from them.
					Object.keys(settings).forEach((key) => {
						if (!has(params, key) && !isFunction(settings[key])) {
							params[key] = settings[key];
						}
					});
				} else if (method === 'create') {
					methodName = config.create;
					params.body = payload(record, model.toJSON());
					if (isFunction(config.beforeCreate)) {
						params.body = config.beforeCreate(params.body, model);
					}
				} else if (method === 'update' || method === 'patch') {
					const partial = method === 'patch' || settings.patch === true;
					methodName = partial ? config.patch || config.update : config.update;
					let attrs;
					if (settings.attrs) {
						attrs = settings.attrs; // Backbone 1.x: save(attrs, { patch: true })
					} else if (settings.changes && Object.keys(settings.changes).length) {
						// Backbone 0.9.2 reports what this save changed; upstream sent only that.
						attrs = {};
						Object.keys(settings.changes).forEach((key) => {
							attrs[key] = model.get(key);
						});
					} else if (partial) {
						attrs = model.changedAttributes() || {};
					} else {
						attrs = model.toJSON();
					}
					params.body = payload(record, attrs);
					if (isFunction(config.beforeUpdate)) {
						params.body = config.beforeUpdate(params.body, model);
					}
				} else if (method === 'delete') {
					methodName = config.delete;
					if (isFunction(config.beforeDelete)) {
						params.body = config.beforeDelete(payload(record, model.toJSON()), model);
					}
				}

				if (!methodName || !state.hasMethod(methodName)) {
					return rejected(ResteError('config', 'RESTe :: model "' + config.name + '" has no ' + method + ' method'
						+ (methodName ? ' (' + methodName + ' is not defined)' : '')), settings, model);
				}
				// Placeholders the call did not fill come from options.params, then from the model's own attributes
				// (a nested resource: jobs/<jobId>/offers/<id>).
				const endpoint = state.endpointOf(methodName);
				if (endpoint) {
					endpoint.template.names.forEach((name) => {
						if (params[name] === undefined || isObject(params[name])) {
							const given = settings.params && settings.params[name] !== undefined ? settings.params[name] : model.get(name);
							if (given !== undefined && !(name === 'query' && isObject(params[name]))) {
								params[name] = given;
							}
						}
					});
				}
				if (isObject(settings.query) && method !== 'read') {
					params.query = settings.query;
				}

				const handle = state.call(methodName, params, callOptions(settings));
				if (!isLegacy()) {
					model.trigger('request', model, handle, settings);
				}
				return derive(handle, (response) => {
					const data = method === 'delete' ? null : modelData(record, response);
					if (method === 'delete' && record.identity && model.id != null) {
						record.identity.delete(model.id);
					}
					if (method !== 'delete') {
						model.receivedAt = Date.now();
					}
					if (isFunction(settings.success)) {
						settings.success(data);
					}
					if (record.identity && model.id != null && method !== 'delete' && !record.identity.has(model.id)) {
						record.identity.set(model.id, model);
					}
					return model;
				}, (error) => {
					if (isFunction(settings.error)) {
						settings.error(error);
					}
					throw error;
				});
			}

			function transformOf(config) {
				 
				return function (_model, transform) {
					if (transform) {
						this.__transform = transform(this);
					} else if (config && isFunction(config.transform)) {
						this.__transform = config.transform(this);
					} else {
						this.__transform = this.toJSON();
					}
					return this.__transform;
				};
			}

			/**
			 * save(attrs, { optimistic: true }): the change shows at once and is undone if the server refuses it.
			 * Only attributes that still hold the optimistic value are restored, so a newer change is not lost.
			 */
			function optimisticSave(Base, model, key, value, options) {
				let attrs;
				let settings;
				if (key == null || isObject(key)) {
					attrs = key;
					settings = value;
				} else {
					attrs = {};
					attrs[key] = value;
					settings = options;
				}
				settings = settings ? Object.assign({}, settings) : {};
				const record = records[model._type];
				const wanted = settings.optimistic !== undefined ? settings.optimistic : record && record.config.optimistic;
				if (!wanted || settings.wait || !attrs) {
					return Base.prototype.save.call(model, attrs, settings);
				}
				const previous = {};
				Object.keys(attrs).forEach((name) => {
					previous[name] = has(model.attributes, name) ? model.get(name) : undefined; // null is a value
				});
				const userError = settings.error;
				let release = noop;
				settings.error = function (target, error) {
					const failure = error === undefined ? target : error;
					release();
					const restore = {};
					const drop = [];
					Object.keys(attrs).forEach((name) => {
						if (deepEqual(model.get(name), attrs[name])) {
							if (previous[name] === undefined) {
								drop.push(name);
							} else {
								restore[name] = previous[name];
							}
						}
					});
					drop.forEach(name => model.unset(name));
					if (Object.keys(restore).length) {
						model.set(restore);
					}
					model.trigger('rollback', model, failure, settings);
					if (isFunction(userError)) {
						userError.apply(this, arguments);
					} else if (isLegacy()) {
						model.trigger('error', model, failure, settings); // 0.9.2 only fires "error" without a callback
					}
				};
				const request = Base.prototype.save.call(model, attrs, settings);
				if (request && isFunction(request.then)) {
					release = holdAttributes(model, Object.keys(attrs));
					request.then(() => whenLoadsLanded(release), release);
				}
				return request;
			}

			/**
			 * Marks attributes as changed on the device and not yet answered by the server: a list response that was
			 * requested before the change must not put the old values back. Returns the function that lifts the mark.
			 */
			function holdAttributes(model, names) {
				const pending = model._pendingAttrs || (model._pendingAttrs = {});
				names.forEach((name) => {
					pending[name] = (pending[name] || 0) + 1;
				});
				let released = false;
				return function () {
					if (released) {
						return;
					}
					released = true;
					names.forEach((name) => {
						if (--pending[name] <= 0) {
							delete pending[name];
						}
					});
				};
			}

			function optimisticChange(model, changes, send) {
				const previous = {};
				Object.keys(changes).forEach((name) => {
					previous[name] = has(model.attributes, name) ? model.get(name) : undefined; // null is a value
				});
				model.set(changes);
				const release = holdAttributes(model, Object.keys(changes));
				const result = Promise.resolve().then(send).then((resource) => {
					whenLoadsLanded(release);
					if (isPlainObject(resource)) {
						const diff = diffAttributes(model.attributes, resource);
						if (diff) {
							model.set(diff);
						}
						model.receivedAt = Date.now();
					}
					return model;
				}, (error) => {
					release();
					Object.keys(changes).forEach((name) => {
						if (deepEqual(model.get(name), changes[name])) {
							if (previous[name] === undefined) {
								model.unset(name);
							} else {
								model.set(name, previous[name]);
							}
						}
					});
					model.trigger('rollback', model, error, {});
					throw error;
				});
				return result;
			}

			/**
			 * collection.optimistic(attributes, send): the model is in the list now; when `send()` resolves the
			 * server's resource it takes those attributes (and the real id) in place, and when it fails the model is
			 * taken out again. If the server's copy got into the collection first (a socket event beat the response),
			 * that one is kept and the temporary model is dropped.
			 */
			function optimisticAdd(meta, collection, attributes, send, options) {
				const record = meta.record;
				const model = new record.Model(mirrored(record, attributes));
				model._pendingCreate = true; // a refresh that lands meanwhile must not drop it
				collection.add(model, options);
				meta.mutations++;
				return Promise.resolve().then(send).then((resource) => {
					if (isPlainObject(resource)) {
						return settleCreated(meta, collection, model, mirrored(record, resource));
					}
					model._pendingCreate = false;
					return model;
				}, (error) => {
					model._pendingCreate = false;
					collection.remove(model);
					model.trigger('rollback', model, error, {});
					throw error;
				});
			}

			/** Gives a model created on the client its server attributes, or folds it into the copy that already arrived. */
			function settleCreated(meta, collection, model, resource) {
				const record = meta.record;
				const id = resource[record.idAttribute];
				whenLoadsLanded(() => {
					model._pendingCreate = false;
				});
				const existing = id != null && id !== model.id ? collection.get(id) || (record.identity ? record.identity.get(id) : null) : null;
				if (existing && existing !== model) {
					collection.remove(model);
					const diff = diffAttributes(existing.attributes, resource);
					if (diff) {
						existing.set(diff);
					}
					if (collection.get(id) !== existing) {
						collection.add(existing);
					}
					existing.receivedAt = Date.now();
					return existing;
				}
				const diff = diffAttributes(model.attributes, resource);
				if (diff) {
					model.set(diff);
				}
				model.receivedAt = Date.now();
				if (record.identity && model.id != null) {
					record.identity.set(model.id, model);
				}
				return model;
			}

			/** destroy({ optimistic: true }): removed at once, put back where it was if the server refuses. */
			function optimisticDestroy(Base, model, options) {
				const settings = options ? Object.assign({}, options) : {};
				const record = records[model._type];
				const wanted = settings.optimistic !== undefined ? settings.optimistic : record && record.config.optimistic;
				if (!wanted || settings.wait || model.isNew()) {
					return Base.prototype.destroy.call(model, settings);
				}
				const places = [];
				Object.keys(collections).forEach((name) => {
					const index = collections[name].indexOf(model);
					if (index !== -1) {
						places.push({ collection: collections[name], index });
					}
				});
				const userError = settings.error;
				const id = model.id;
				// Until the server has answered, a list response that still contains the model must not re-add it.
				if (record) {
					record.destroying.set(id, (record.destroying.get(id) || 0) + 1);
				}
				const settled = () => {
					if (record) {
						const left = (record.destroying.get(id) || 1) - 1;
						if (left > 0) {
							record.destroying.set(id, left);
						} else {
							record.destroying.delete(id);
						}
					}
				};
				settings.error = function (target, error) {
					const failure = error === undefined ? target : error;
					settled();
					places.forEach((place) => {
						if (place.collection.indexOf(model) === -1) {
							place.collection.add(model, { at: Math.min(place.index, place.collection.length) });
						}
					});
					if (record && record.identity && model.id != null) {
						record.identity.set(model.id, model);
					}
					model.trigger('rollback', model, failure, settings);
					if (isFunction(userError)) {
						userError.apply(this, arguments);
					} else if (isLegacy()) {
						model.trigger('error', model, failure, settings);
					}
				};
				const request = Base.prototype.destroy.call(model, settings);
				if (request && isFunction(request.then)) {
					request.then(() => whenLoadsLanded(settled), noop);
				} else {
					settled();
				}
				return request;
			}

			function addModel(args) {
				const BB = backbone();
				reste.modelConfig = reste.modelConfig || {};
				reste.modelConfig[args.name] = args;
				// 1.x: Backbone's id is `id`, and the attribute named in the config is copied into it. With
				// `mirrorId: false` the configured attribute is Backbone's id and nothing is copied.
				const sourceId = args.id || 'id';
				const mirrorId = sourceId !== 'id' && args.mirrorId !== false;
				const identityOption = args.identity !== undefined ? args.identity : state.config.identity;
				const record = {
					config: args,
					sourceId,
					idAttribute: mirrorId ? 'id' : sourceId,
					mirrorId,
					identity: null,
					lists: [], // the collections of this model
					destroying: new Map(), // id -> optimistic destroys the server has not answered yet
					Model: null
				};
				if (identityOption) {
					record.identity = createIdentityMap({
						weak: isObject(identityOption) ? identityOption.weak : undefined,
						limit: isObject(identityOption) ? identityOption.limit : undefined,
						held: model => record.lists.some(list => (model.id != null ? list.get(model.id) === model : false))
					});
				}
				const Base = BB.Model;
				const baseSet = Base.prototype.set;
				record.Model = Base.extend({
					idAttribute: record.idAttribute,
					set(key, value, options) {
						if (!mirrorId || key == null) {
							return baseSet.call(this, key, value, options);
						}
						// However the attributes arrive (the constructor, collection.add, a merge), the configured
						// id attribute also sets `id`.
						let attrs = key;
						let settings = value;
						if (typeof key !== 'object') {
							attrs = {};
							attrs[key] = value;
							settings = options;
						}
						if (attrs.id === undefined && attrs[sourceId] != null && !(settings && settings.unset)) {
							attrs = Object.assign({ id: attrs[sourceId] }, attrs);
						}
						return baseSet.call(this, attrs, settings);
					},
					_type: args.name,
					_method: args.name,
					sync(method, model, options) {
						return modelSync(record, method, model, options);
					},
					transform: transformOf(args),
					save(key, value, options) {
						return optimisticSave(Base, this, key, value, options);
					},
					destroy(options) {
						return optimisticDestroy(Base, this, options);
					},
					/**
					 * An optimistic change whose request is not the model's own save: the attributes change now,
					 * `send()` (a function returning a promise) runs, and they are put back if it fails. When it
					 * resolves an object, that is merged in as the server's answer.
					 */
					optimistic(changes, send) {
						return optimisticChange(this, changes, send);
					},
					/** Makes the model hold exactly `attributes`: keys they lack are removed; only real changes fire. */
					replace(attributes) {
						return replaceAttributes(this, mirrored(record, attributes || {}));
					}
				});
				records[args.name] = record;

				if (args.singleton) {
					const name = args.singleton === true ? args.name : args.singleton;
					const instance = new record.Model();
					state.models[name] = instance;
					const app = alloy();
					if (app) {
						app.Models = app.Models || {};
						app.Models[name] = app.Models[name] || instance;
					}
				}

				(args.collections || []).forEach(collection => addCollection(record, collection));
				return record.Model;
			}

			function createModel(name, attributes) {
				const record = records[name];
				if (record) {
					const attrs = mirrored(record, attributes);
					const id = attrs ? attrs[record.idAttribute] : null;
					if (record.identity && id != null) {
						const known = record.identity.get(id);
						if (known) {
							const diff = diffAttributes(known.attributes, attrs);
							if (diff) {
								known.set(diff);
							}
							return known;
						}
					}
					const model = new record.Model(attrs);
					if (record.identity && id != null) {
						record.identity.set(id, model);
					}
					return model;
				}
				// Upstream: any name gives a plain model with transform().
				const BB = backbone();
				const model = new BB.Model(attributes);
				model.transform = transformOf(reste.modelConfig && reste.modelConfig[name]);
				model._type = name;
				return model;
			}

			/** The one instance for an id (identity models): created empty when not known yet, ready to fetch(). */
			function modelFor(name, id) {
				const record = records[name];
				if (!record) {
					throw new Error('RESTe :: unknown model ' + name);
				}
				const attrs = {};
				attrs[record.sourceId] = id;
				return createModel(name, attrs);
			}

			// ------------------------------------------------------------------ collections

			function createCollection(name, content) {
				if (!Array.isArray(content)) {
					throw new Error('No Array specified for createCollection');
				}
				const BB = backbone();
				const app = alloy();
				let collection = (app && app.Collections && app.Collections[name]) || collections[name];
				if (!collection) {
					collection = new BB.Collection();
					if (app) {
						app.Collections = app.Collections || {};
						app.Collections[name] = collection;
					}
				}
				collections[name] = collection;
				collection.reset(content);
				collection.fetch = function () {
					collection.trigger('change');
				};
				return collection;
			}

			function addCollection(record, config) {
				const BB = backbone();
				const app = alloy();
				let collection = app && app.Collections ? app.Collections[config.name] : null;
				if (!collection) {
					collection = collections[config.name] || new BB.Collection();
				}
				if (app) {
					app.Collections = app.Collections || {};
					app.Collections[config.name] = collection;
				}
				collections[config.name] = collection;
				if (record.lists.indexOf(collection) === -1) {
					record.lists.push(collection);
				}

				const Base = BB.Collection.prototype;
				const meta = {
					record, config, pager: null,
					// What the collection held after its last refresh, to recognise "nothing changed" cheaply.
					mutations: 0, cleanAt: -1, lastUrl: null, lastEtag: null, lastHash: null, lastLength: -1
				};
				collection._reste = meta;
				collection._type = record.config.name;
				collection._name = config.name;
				collection.model = record.Model;
				collection.meta = null;
				collection.paging = null;

				collection.sync = function (method, target, options) {
					return listSync(meta, target, options || {});
				};

				collection.trigger = function (name) {
					if (name === 'change' || name === 'add' || name === 'remove' || name === 'reset' || name === 'sort') {
						meta.mutations++;
					}
					if (batch.depth > 0 && isCoalesced(name)) {
						// Held back while a merge runs; the merge announces everything once at its end.
						const entry = touch(batch.dirty, this);
						const model = arguments[1];
						if (model && model.cid !== undefined) {
							if (name === 'change') {
								entry.merged.add(model);
							} else if (name === 'add') {
								entry.added.add(model);
							} else if (name === 'remove') {
								entry.removed.add(model);
							}
						}
						return this;
					}
					return Base.trigger.apply(this, arguments);
				};

				/**
				 * fetch() as Backbone does it (reset or set), or, with `merge: true` on the call or on the collection's
				 * config, merged in place: same model instances, change events only for what changed, the bound list
				 * rendered once.
				 */
				collection.fetch = function (options) {
					const settings = options ? Object.assign({}, options) : {};
					const merge = settings.merge !== undefined ? settings.merge : config.merge;
					if (!merge || settings.reset) {
						return Base.fetch.call(this, settings);
					}
					return mergeLoad(meta, this, settings, 'refresh');
				};

				collection.refresh = function (options) {
					return mergeLoad(meta, this, options ? Object.assign({}, options) : {}, 'refresh');
				};

				collection.fetchNext = function (options) {
					return mergeLoad(meta, this, options ? Object.assign({}, options) : {}, 'next');
				};

				collection.fetchPrevious = function (options) {
					return mergeLoad(meta, this, options ? Object.assign({}, options) : {}, 'previous');
				};

				collection.hasMore = function () {
					return meta.pager && meta.pager.loaded ? meta.pager.hasMore : false;
				};

				/** Merges items (from a socket, a push payload, another response) into the collection. */
				collection.upsert = function (items, options) {
					const settings = options || {};
					meta.mutations++;
					return merger.upsert(this, Array.isArray(items) ? items : [items], mergeSettings(meta, settings, settings.mode || 'merge',
						settings.position || 'end'));
				};

				collection.optimistic = function (attributes, send, options) {
					return optimisticAdd(meta, this, attributes, send, options);
				};

				/** create(attrs, { optimistic: true }): shown at once, taken out again if the server refuses it. */
				collection.create = function (attributes, options) {
					const settings = options ? Object.assign({}, options) : {};
					const wanted = settings.optimistic !== undefined ? settings.optimistic : record.config.optimistic;
					if (!wanted || settings.wait) {
						return Base.create.call(this, attributes, settings);
					}
					const self = this;
					const userError = settings.error;
					let created = null;
					settings.error = function (target, error) {
						const failure = error === undefined ? target : error;
						if (created) {
							created._pendingCreate = false;
							self.remove(created);
							created.trigger('rollback', created, failure, settings);
						}
						if (isFunction(userError)) {
							userError.apply(this, arguments);
						} else if (created && isLegacy()) {
							created.trigger('error', created, failure, settings);
						}
					};
					const userSuccess = settings.success;
					settings.success = function () {
						// The server's copy may have reached the collection first (a socket event): keep one row.
						if (created && created.id != null) {
							const twin = self.models.find(other => other !== created && other.id === created.id);
							if (twin) {
								self.remove(twin);
							}
						}
						if (isFunction(userSuccess)) {
							userSuccess.apply(this, arguments);
						}
					};
					delete settings.optimistic; // the model's own save must not try to roll attributes back
					const userDone = settings.success;
					settings.success = function () {
						const model = created;
						if (model) {
							whenLoadsLanded(() => {
								model._pendingCreate = false;
							});
						}
						return userDone.apply(this, arguments);
					};
					created = Base.create.call(this, attributes, settings);
					if (created) {
						created._pendingCreate = created.isNew(); // a refresh that lands before the answer keeps it
					}
					return created;
				};

				return collection;
			}

			function paginationOf(meta) {
				const endpoint = state.endpointOf(meta.config.read);
				return normalizePagination(meta.config.paginate, endpoint ? endpoint.paginate : state.pagination);
			}

			function mergeSettings(meta, settings, mode, position) {
				const record = meta.record;
				const config = meta.config;
				return {
					Model: record.Model,
					idAttribute: record.idAttribute,
					sourceId: record.sourceId,
					mirrorId: record.mirrorId,
					identity: record.identity,
					destroying: record.destroying,
					mode,
					position,
					chunk: settings.chunk !== undefined ? settings.chunk : (config.chunk !== undefined ? config.chunk : state.config.chunk),
					events: settings.events || config.events || state.config.events,
					changeEvent: config.changeEvent || state.config.changeEvent,
					isStale: (generation => () => generation !== state.generation)(state.generation)
				};
			}

			/** The request parameters of a list load: the collection's fixed ones, then the call's. */
			function listParams(meta, settings, query) {
				const config = meta.config;
				const params = Object.assign({}, config.params);
				Object.keys(settings).forEach((key) => {
					if (key !== 'query' && key !== 'params' && !isFunction(settings[key])) {
						params[key] = settings[key]; // upstream: fetch({ name: 'home' }) fills <name>
					}
				});
				Object.assign(params, settings.params);
				if (settings.query !== undefined && !isObject(settings.query)) {
					params.query = settings.query; // a <query> placeholder, not a query string
					return params;
				}
				const merged = Object.assign({}, config.query, settings.query, query);
				if (Object.keys(merged).length) {
					params.query = merged;
				}
				return params;
			}

			function pagerOf(meta, collection) {
				if (meta.pager) {
					return meta.pager;
				}
				const pagination = paginationOf(meta);
				if (!pagination) {
					return null;
				}
				meta.pager = createPager(pagination, {
					perPage: meta.config.perPage,
					limit: meta.config.limit,
					content: meta.config.content,
					held: () => collection.models.filter(model => !model._pendingCreate) // a cursor is a row the server has seen
				}, null, null);
				return meta.pager;
			}

			function publish(meta, collection, page) {
				collection.meta = page.meta;
				const pager = meta.pager;
				collection.paging = pager ? {
					style: pager.style, page: pager.page, lastPage: pager.lastPage, total: pager.total, hasMore: pager.hasMore,
					hasPrevious: pager.hasPrevious, nextCursor: pager.nextCursor
				} : null;
			}

			/** Backbone's own fetch path: sync('read') hands the items to Backbone, which resets or sets. */
			function listSync(meta, collection, settings) {
				const config = meta.config;
				if (!config.read || !state.hasMethod(config.read)) {
					return rejected(ResteError('config', 'RESTe :: collection "' + config.name + '" has no read method'
						+ (config.read ? ' (' + config.read + ' is not defined)' : '')), settings, collection);
				}
				const pagination = paginationOf(meta);
				let query = null;
				let request = null;
				if (pagination) {
					// A plain fetch() of a paginated collection is its first page.
					const pager = pagerOf(meta, collection);
					pager.reset();
					query = {};
					request = {};
					const size = meta.config.perPage || meta.config.limit || pagination.perPage || pagination.limit;
					if (pagination.style === 'page') {
						query[pagination.pageParam] = request.page = pagination.firstPage;
						if (size) {
							query[pagination.perPageParam] = request.perPage = size;
						}
					} else if (size) {
						query[pagination.limitParam] = request.limit = size;
					}
				}
				const handle = state.call(config.read, listParams(meta, settings, query), callOptions(settings));
				if (!isLegacy()) {
					collection.trigger('request', collection, handle, settings);
				}
				return derive(handle, (response) => {
					let page;
					if (pagination) {
						page = readPage(pagination, response, request, config.content);
						const pager = meta.pager;
						pager.loaded = true;
						pager.meta = page.meta;
						pager.hasMore = page.hasMore;
						pager.page = page.page === null ? request.page || 0 : page.page;
						pager.lastPage = page.lastPage;
						pager.total = page.total;
						pager.nextCursor = page.nextCursor;
						pager.previousCursor = page.previousCursor;
					} else {
						page = readPage({ style: 'page', items: null, meta: config.meta || null }, response, null, config.content);
					}
					publish(meta, collection, page);
					meta.mutations++;
					const items = meta.record.mirrorId ? page.items.map(item => mirrored(meta.record, item)) : page.items;
					if (isFunction(settings.success)) {
						settings.success(items);
					}
					if (isLegacy()) {
						collection.trigger('sync', collection, items, settings); // Backbone 0.9.2 does not; upstream did
					}
					return collection;
				}, (error) => {
					if (isFunction(settings.error)) {
						settings.error(error);
					}
					throw error;
				});
			}

			/** RESTe's own path: refresh, next page, previous page, merged in place. */
			function mergeLoad(meta, collection, settings, direction) {
				const config = meta.config;
				const fail = (error) => {
					if (isFunction(settings.error)) {
						settings.error(collection, error, settings);
					}
					collection.trigger('error', collection, error, settings);
					throw error;
				};
				const finished = (promise, abortRequest) => {
					const result = trackLoad(promise).then(null, fail);
					result.abort = result.cancel = abortRequest || notAborted;
					result.catch(noop);
					return result;
				};
				if (!config.read || !state.hasMethod(config.read)) {
					return finished(Promise.reject(ResteError('config', 'RESTe :: collection "' + config.name + '" has no read method'
						+ (config.read ? ' (' + config.read + ' is not defined)' : ''))));
				}
				const pagination = paginationOf(meta);
				if (!pagination && direction !== 'refresh') {
					return finished(Promise.reject(ResteError('config', 'RESTe :: collection "' + config.name + '" is not paginated')));
				}
				const generation = state.generation;
				const replace = direction === 'refresh';
				const skipUnchanged = (settings.skipUnchanged !== undefined ? settings.skipUnchanged : config.skipUnchanged) !== false;
				const done = (page) => {
					const body = page.response ? page.response.body : null;
					if (isFunction(settings.success)) {
						settings.success(collection, body, settings);
					}
					collection.trigger('sync', collection, body, settings);
					return page;
				};
				const unchanged = () => ({ models: collection.models.slice(), added: [], changed: [], removed: [], touched: false, unchanged: true });
				// Nothing has touched the collection since its last refresh of `url`.
				const isClean = url => meta.cleanAt === meta.mutations && meta.lastUrl === url && collection.length > 0;
				const requestOptions = () => {
					const options = callOptions(settings);
					if (replace && skipUnchanged && meta.lastHash !== null && meta.cleanAt === meta.mutations && collection.length > 0) {
						// Lets the request skip parsing when the server sends the same bytes again.
						options.unchangedIf = { url: meta.lastUrl, length: meta.lastLength, hash: meta.lastHash };
					}
					return options;
				};
				// The collection changed while the request was in flight: the body is needed after all.
				const ready = response => (response.unchanged && !isClean(response.url) ? response.materialize() : response);
				// What the collection held when a refresh was sent. The refresh speaks for those rows; one that got
				// here later (a socket event, another response) is not in a list the server made before it.
				let known = null;
				const sent = () => {
					known = replace ? new Set(collection.models) : null;
				};

				const apply = (page) => {
					if (generation !== state.generation) {
						throw ResteError('stale', 'RESTe :: the session ended while ' + config.read + ' was in flight');
					}
					const response = page.response;
					if (page.unchanged) {
						return unchanged(); // the same bytes as the last refresh, and nothing touched the collection since
					}
					if (replace && skipUnchanged) {
						const etag = response.header('ETag');
						if (response.fromCache) {
							// A cache hit or a 304 for the representation this collection was last refreshed from.
							if (isClean(response.url) && etag && etag === meta.lastEtag) {
								return unchanged();
							}
							meta.lastHash = null;
						} else {
							const text = response.text || '';
							meta.lastLength = text.length;
							meta.lastHash = hashString(text);
						}
						meta.lastEtag = etag;
					}
					let position = 'end';
					if (pagination && pagination.style === 'cursor') {
						const oldestFirst = pagination.order !== 'desc';
						position = (direction === 'next') === oldestFirst ? 'start' : 'end';
					}
					const merging = mergeSettings(meta, settings, replace ? 'replace' : 'merge', position);
					if (known) {
						const held = known;
						merging.arrived = model => !held.has(model);
					}
					return merger.upsert(collection, page.items, merging);
				};
				const settled = (page) => {
					if (page.unchanged) {
						return page;
					}
					publish(meta, collection, page);
					if (replace && page.response) {
						// A row the refresh kept without the server having listed it: the next refresh has to look
						// at the collection again, also when the server sends the same bytes.
						meta.cleanAt = page.models && page.models.length !== collection.length ? -1 : meta.mutations;
						meta.lastUrl = page.response.url;
					} else if (page.response) {
						meta.mutations++; // more than the first page is held now
					}
					return page;
				};

				if (!pagination) {
					sent();
					const handle = state.call(config.read, listParams(meta, settings, null), requestOptions());
					collection.trigger('request', collection, handle, settings);
					return finished(handle.then((response) => {
						const page = ready(response).unchanged ? { items: [], meta: collection.meta, unchanged: true }
							: readPage({ style: 'page', items: null, meta: config.meta || null }, response, null, config.content);
						page.response = response;
						return Promise.resolve(apply(page)).then(result => done(settled(Object.assign(page, result))));
					}), handle.abort);
				}

				const pager = pagerOf(meta, collection);
				let requestHandle = null;
				const hooks = {
					call(query) {
						sent();
						requestHandle = state.call(config.read, listParams(meta, settings, query), requestOptions());
						collection.trigger('request', collection, requestHandle, settings);
						const prepared = requestHandle.then(ready);
						prepared.abort = requestHandle.abort;
						return prepared;
					},
					apply
				};
				const loading = replace ? pager.refresh(hooks) : direction === 'next' ? pager.next(hooks) : pager.previous(hooks);
				const joined = requestHandle === null; // another call is already loading this direction, or the list is complete
				return finished(loading.then((page) => {
					if (page.discarded || !page.response) {
						return page;
					}
					if (joined) {
						if (isFunction(settings.success)) {
							settings.success(collection, page.response.body, settings);
						}
						return page;
					}
					return done(settled(page));
				}), () => (requestHandle && requestHandle.abort ? requestHandle.abort() : false));
			}

			// ------------------------------------------------------------------ the app's own models and collections

			/**
			 * What RESTe needs to know about a collection it did not create: its model class and id attribute. Such
			 * a collection keeps Backbone's own events (RESTe holds events back only on its own collections).
			 */
			function foreign(collection) {
				const Model = collection.model || backbone().Model;
				const idAttribute = (Model.prototype && Model.prototype.idAttribute) || 'id';
				return {
					record: { Model, idAttribute, sourceId: idAttribute, mirrorId: false, identity: null, destroying: null },
					config: {},
					mutations: 0
				};
			}

			function foreignSettings(collection, settings, mode, position) {
				const record = foreign(collection).record;
				return {
					Model: record.Model,
					idAttribute: record.idAttribute,
					mode,
					position,
					chunk: settings.chunk,
					events: 'each',
					isStale: (generation => () => generation !== state.generation)(state.generation)
				};
			}

			/** api.upsert(collection, items, options): collection.upsert() for any Backbone collection. */
			function upsert(collection, items, options) {
				if (collection._reste) {
					return collection.upsert(items, options);
				}
				const settings = options || {};
				return merger.upsert(collection, Array.isArray(items) ? items : [items],
					foreignSettings(collection, settings, settings.mode || 'merge', settings.position || 'end'));
			}

			/** api.replace(model, attributes): model.replace() for any Backbone model. */
			function replace(model, attributes) {
				return isFunction(model.replace) && records[model._type] ? model.replace(attributes) : replaceAttributes(model, attributes || {});
			}

			/**
			 * api.optimistic(target, attributes, send, options): model.optimistic() for any Backbone model,
			 * collection.optimistic() for any Backbone collection.
			 */
			function optimistic(target, attributes, send, options) {
				if (Array.isArray(target.models) && isFunction(target.add)) {
					return optimisticAdd(target._reste || foreign(target), target, attributes, send, options);
				}
				return optimisticChange(target, attributes, send);
			}

			/** api.list(): a list that follows a collection (see list.js). */
			function liveList(options) {
				const settings = options || {};
				const collection = typeof settings.collection === 'string' ? collections[settings.collection] : settings.collection;
				const meta = collection && collection._reste;
				const load = isFunction(settings.load) ? settings.load : null;
				if (!collection || (!meta && !load)) {
					throw new Error('RESTe :: list() needs a collection from the models config (or any collection, with `load`)');
				}
				const config = meta ? meta.config : {};
				const method = load ? null : settings.method || config.read;
				if (!load && (!method || !state.hasMethod(method))) {
					throw new Error('RESTe :: list() has no method to load from' + (method ? ' (' + method + ' is not defined)' : ''));
				}
				const endpoint = state.endpointOf(method || config.read);
				const pagination = normalizePagination(settings.paginate !== undefined ? settings.paginate : config.paginate,
					endpoint ? endpoint.paginate : state.pagination);
				return createLiveList({
					Events: backbone().Events,
					collection,
					pagination,
					content: settings.content !== undefined ? settings.content : (load ? undefined : config.content),
					track: trackLoad,
					request(params, query, signal) {
						const all = Object.assign({}, config.params, isFunction(params) ? params() : params);
						const merged = Object.assign({}, config.query, isFunction(query) ? query() : query);
						if (load) {
							// The app loads the page itself (a service call, say) and answers { items, meta }. It is
							// asked at once, as a method would be called at once; what it throws is a rejection.
							let loading;
							try {
								loading = Promise.resolve(load(merged, { signal, params: all }));
							} catch (error) {
								loading = Promise.reject(error);
							}
							return loading.then(loadedPage);
						}
						if (Object.keys(merged).length) {
							all.query = merged;
						}
						return state.call(method, all, Object.assign({}, settings.request, { fullResponse: true, signal }));
					},
					merge(items) {
						if (!meta) {
							return merger.upsert(collection, items, foreignSettings(collection, settings, 'merge', 'end'));
						}
						meta.mutations++;
						return merger.upsert(collection, items, mergeSettings(meta, settings, 'merge', 'end'));
					}
				}, settings);
			}

			/** What a `load` function resolved, in the shape a page is read from. */
			function loadedPage(result) {
				const items = Array.isArray(result) ? result : (result && result.items);
				return {
					status: 200,
					endpoint: 'load()',
					body: result,
					data: items,
					meta: result && !Array.isArray(result) && result.meta !== undefined ? result.meta : null,
					unchanged: false
				};
			}

			function reset(options) {
				Object.keys(records).forEach((name) => {
					if (records[name].identity) {
						records[name].identity.clear();
					}
				});
				Object.keys(collections).forEach((name) => {
					const collection = collections[name];
					const meta = collection._reste;
					if (meta) {
						// The next session starts from the first page, and nothing is "unchanged since last time".
						if (meta.pager) {
							meta.pager.reset();
						}
						meta.cleanAt = -1;
						meta.lastUrl = meta.lastEtag = meta.lastHash = null;
						meta.lastLength = -1;
						collection.meta = null;
						collection.paging = null;
					}
					if (options && options.resetCollections) {
						collection.reset([]);
					}
				});
				Object.keys(state.models).forEach((name) => {
					if (options && options.resetCollections) {
						state.models[name].clear();
					}
				});
			}

			return {
				addModel,
				createModel,
				modelFor,
				createCollection,
				liveList,
				upsert,
				replace,
				optimistic,
				collections,
				records,
				merger,
				reset,
				identity: {
					get(name, id) {
						const record = records[name];
						return record && record.identity ? record.identity.get(id) || null : null;
					},
					clear(name) {
						Object.keys(records).forEach((key) => {
							if ((!name || key === name) && records[key].identity) {
								records[key].identity.clear();
							}
						});
					},
					/** How many models the identity map of a model holds. */
					size(name) {
						const record = records[name];
						return record && record.identity ? record.identity.size : 0;
					},
					sizes() {
						const out = {};
						Object.keys(records).forEach((key) => {
							if (records[key].identity) {
								out[key] = records[key].identity.size;
							}
						});
						return out;
					}
				}
			};
		}

		module.exports = { createData };
	}
};
