'use strict';

const { deepEqual, isObject, isFunction, later } = require('./util');
const { ResteError } = require('./errors');

/**
 * The attributes of `incoming` that differ from `current`, or null when none do. Keys `incoming` lacks are
 * left alone: a list row usually carries fewer fields than the detail of the same resource.
 */
function diffAttributes(current, incoming) {
	let diff = null;
	const keys = Object.keys(incoming);
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		const a = current[key];
		const b = incoming[key];
		if (a === b) {
			continue;
		}
		if (isObject(a) && isObject(b) && deepEqual(a, b)) {
			continue;
		}
		(diff || (diff = {}))[key] = b;
	}
	return diff;
}

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

/**
 * Merging API items into Backbone collections without rebuilding them. Works on every Backbone version Alloy
 * ships (0.9.2 has no Collection#set), so it does not use Backbone's own merge.
 *
 * `batch` is shared by all collections of one RESTe instance: { depth, dirty }.
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
		const mirror = settings.mirrorId && idAttribute !== 'id';
		const identity = settings.identity || null;
		const replace = settings.mode === 'replace';
		const coalesce = settings.events !== 'each';
		const atStart = settings.position === 'start';
		const job = { models: [], added: [], changed: [], removed: [], dirty: new Set(), insertAt: 0, reordered: false };
		const pending = new Map(); // id (or cid) -> model seen in this merge and not in the collection yet

		function begin() {
			if (coalesce) {
				batch.depth++;
			}
		}

		function end() {
			if (coalesce && --batch.depth === 0) {
				batch.dirty.forEach(touched => job.dirty.add(touched));
				batch.dirty.clear();
			}
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
						if (mirror && attrs.id === undefined && attrs[idAttribute] !== undefined) {
							attrs = Object.assign({ id: attrs[idAttribute] }, attrs);
						}
						model = find(attrs[idAttribute]);
						if (model) {
							const diff = diffAttributes(model.attributes, attrs);
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
			job.models.forEach((model) => {
				if (!wanted.has(model)) {
					wanted.add(model);
					desired.push(model);
				}
			});
			job.models = desired;
			const current = collection.models;
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
				job.dirty.add(collection);
			}
			if (batch.depth > 0) {
				// Inside another merge: that one announces the change.
				job.dirty.forEach(dirty => batch.dirty.add(dirty));
				return result;
			}
			const changeEvent = settings.changeEvent || 'fetch';
			job.dirty.forEach((dirty) => {
				if (dirty === collection) {
					dirty.trigger('update', dirty, { changes: { added: job.added, removed: job.removed, merged: job.changed } });
				}
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
			step();
		});
	}

	return { upsert };
}

module.exports = { createMerger, diffAttributes, isCoalesced };
