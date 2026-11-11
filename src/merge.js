'use strict';

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
	 *           position ('end' | 'start'), chunk, events ('coalesce' | 'each'), changeEvent, isStale()
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
			// yet: it keeps its place.
			current.forEach((model, index) => {
				if (model._pendingCreate && !wanted.has(model)) {
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
