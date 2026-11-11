'use strict';

const { ResteError } = require('./errors');
const { createMerger, diffAttributes, isCoalesced, touch } = require('./merge');
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
				const next = mirrored(record, attributes || {});
				const gone = Object.keys(this.attributes).filter(key => !has(next, key));
				gone.forEach(key => this.unset(key));
				const diff = diffAttributes(this.attributes, next);
				if (diff) {
					this.set(diff);
				}
				return this;
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
			held: () => collection.models
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
			return merger.upsert(collection, page.items, mergeSettings(meta, settings, replace ? 'replace' : 'merge', position));
		};
		const settled = (page) => {
			if (page.unchanged) {
				return page;
			}
			publish(meta, collection, page);
			if (replace && page.response) {
				meta.cleanAt = meta.mutations;
				meta.lastUrl = page.response.url;
			} else if (page.response) {
				meta.mutations++; // more than the first page is held now
			}
			return page;
		};

		if (!pagination) {
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

	/** api.list(): a list that follows one of the collections (see list.js). */
	function liveList(options) {
		const settings = options || {};
		const collection = typeof settings.collection === 'string' ? collections[settings.collection] : settings.collection;
		const meta = collection && collection._reste;
		if (!meta) {
			throw new Error('RESTe :: list() needs a collection from the models config');
		}
		const method = settings.method || meta.config.read;
		if (!method || !state.hasMethod(method)) {
			throw new Error('RESTe :: list() has no method to load from' + (method ? ' (' + method + ' is not defined)' : ''));
		}
		const endpoint = state.endpointOf(method);
		const pagination = normalizePagination(settings.paginate !== undefined ? settings.paginate : meta.config.paginate,
			endpoint ? endpoint.paginate : state.pagination);
		return createLiveList({
			Events: backbone().Events,
			collection,
			pagination,
			content: settings.content !== undefined ? settings.content : meta.config.content,
			track: trackLoad,
			request(params, query, signal) {
				const all = Object.assign({}, meta.config.params, isFunction(params) ? params() : params);
				const merged = Object.assign({}, meta.config.query, isFunction(query) ? query() : query);
				if (Object.keys(merged).length) {
					all.query = merged;
				}
				return state.call(method, all, Object.assign({}, settings.request, { fullResponse: true, signal }));
			},
			merge(items) {
				meta.mutations++;
				return merger.upsert(collection, items, mergeSettings(meta, settings, 'merge', 'end'));
			}
		}, settings);
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
