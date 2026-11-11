'use strict';

const { ResteError } = require('./errors');
const { compileTemplate, isAbsolute, fillTemplate, joinUrl, serializeQuery, withQuery, DEFAULT_QUERY_OPTIONS } = require('./url');
const { createAbortController } = require('./abort');
const { createLogger } = require('./logger');
const { normalizeRetry } = require('./retry');
const { createKeys } = require('./idempotency');
const { createCache, normalizeCachePolicy, propertiesStore, fileStore } = require('./cache');
const { normalizePagination, createPager } = require('./pagination');
const { createPipeline } = require('./client');
const { createData } = require('./sync');
const { isFunction, isObject, isPlainObject, has, uuid } = require('./util');

const VERSION = '2.0.0';

/** The members upstream 1.x defined on an instance: a method may not take one of these names. */
const RESERVED = Object.create(null);
['config', 'setUrl', 'getUrl', 'clearCookies', 'setRequestHeaders', 'changeRequestHeader', 'removeRequestHeaderItem',
	'addMethod', 'addModel', 'createModel', 'createCollection', 'modelConfig'].forEach((name) => {
	RESERVED[name] = true;
});

const VERBS = ['post', 'get', 'put', 'patch', 'delete', 'head']; // upstream's order: the last one defined wins

/** How many compiled URLs a method whose URL is a function keeps. */
const MAX_VARIANTS = 32;

function Reste() {
	if (!(this instanceof Reste)) {
		return new Reste();
	}
	const reste = this;

	const state = {
		config: {},
		logger: createLogger({}),
		headers: [], // [{ name, value }], value may be a function
		queryOptions: DEFAULT_QUERY_OPTIONS,
		idempotency: { header: 'Idempotency-Key', methods: [] },
		retry: null,
		cacheDefaults: null,
		cacheScope: null,
		authStatuses: [401],
		pagination: null,
		cache: createCache({}),
		keys: createKeys(uuid),
		interceptors: { request: [], response: [], error: [] },
		inflight: new Map(),
		active: new Set(),
		episodes: Object.create(null),
		generation: 0,
		seq: 0,
		factory: null,
		random: null,
		models: Object.create(null),
		// Filled below.
		call: null,
		hasMethod: null,
		endpointOf: null,
		retryFor: null
	};
	const records = new Map(); // method name -> { def, endpoint }
	const adhoc = typeof WeakMap === 'function' ? new WeakMap() : null;
	const pipeline = createPipeline(state);
	const data = createData(reste, state);

	// ------------------------------------------------------------------ endpoints

	/** Turns a method definition into what the pipeline needs. Done once, on the method's first call. */
	function compile(def, forcedUrl) {
		const config = state.config;
		let method = 'GET';
		let source = forcedUrl;
		if (def.method) {
			method = String(def.method).toUpperCase();
			if (source === undefined) {
				source = def.url !== undefined ? def.url : def.path;
			}
		} else {
			for (let i = 0; i < VERBS.length; i++) {
				if (def[VERBS[i]]) {
					method = VERBS[i].toUpperCase();
				}
			}
			if (source === undefined) {
				source = def[method.toLowerCase()] || def.get;
			}
		}
		const dynamic = isFunction(source);
		const template = compileTemplate(dynamic ? '' : String(source === undefined ? '' : source));
		const retry = def.retry === undefined ? state.retry : normalizeRetry(def.retry, state.retry);
		return {
			name: def.name || method + ' ' + template.source,
			def,
			method,
			dynamic: dynamic ? source : null,
			template,
			absolute: isAbsolute(template.source),
			queryIsParam: template.names.indexOf('query') !== -1,
			query: isPlainObject(def.query) ? def.query : null,
			headers: def.requestHeaders || def.headers || null,
			globalHeaders: def.globalHeaders,
			timeout: def.timeout,
			deadline: def.deadline,
			expects: def.expects || null,
			onLoad: def.onLoad,
			onError: def.onError,
			beforePost: def.beforePost,
			beforeSend: def.beforeSend,
			mapError: def.mapError,
			encodeParams: def.encodeParams !== undefined ? def.encodeParams : config.encodeParams !== false,
			retry,
			repeatable: def.retry !== undefined && def.retry !== false, // the endpoint says repeating it is harmless
			idempotent: def.idempotent,
			cache: normalizeCachePolicy(def.cache, null) ? normalizeCachePolicy(def.cache, state.cacheDefaults) : null,
			invalidates: def.invalidates ? [].concat(def.invalidates) : null,
			dedupe: def.dedupe,
			multipart: def.multipart === true || def.upload === true,
			form: def.form === true,
			download: def.download === true,
			responseType: def.responseType,
			unwrap: def.unwrap,
			meta: def.meta,
			paginate: normalizePagination(def.paginate, state.pagination),
			fullResponse: def.fullResponse,
			session: def.session,
			statusHooks: def.statusHooks,
			interceptors: def.interceptors || null,
			redact: def.redact ? [].concat(def.redact) : null,
			clientOptions: def.clientOptions,
			securityManager: def.securityManager
		};
	}

	function endpointOf(name) {
		const record = records.get(name);
		if (!record) {
			return null;
		}
		return record.endpoint || (record.endpoint = compile(record.def));
	}

	/** A method whose URL is a function is resolved on every call. */
	function resolved(endpoint, record) {
		if (!endpoint.dynamic) {
			return endpoint;
		}
		const source = String(endpoint.dynamic());
		let cache = record.variants || (record.variants = new Map());
		let variant = cache.get(source);
		if (!variant) {
			if (cache.size >= MAX_VARIANTS) {
				cache = record.variants = new Map(); // a URL that keeps changing must not grow this forever
			}
			variant = compile(record.def, source);
			variant.dynamic = null;
			cache.set(source, variant);
		}
		return variant;
	}

	function invoke(record, params, a, b, c) {
		let onLoad = null;
		let onError = null;
		let options = null;
		if (isFunction(params)) {
			onLoad = params;
			params = null;
			if (isFunction(a)) {
				onError = a;
				if (isObject(b)) {
					options = b;
				}
			} else if (isObject(a)) {
				options = a;
			}
		} else if (isFunction(a)) {
			onLoad = a;
			if (isFunction(b)) {
				onError = b;
				if (isObject(c)) {
					options = c;
				}
			} else if (isObject(b)) {
				options = b;
			}
		} else if (isObject(a)) {
			options = a;
			if (isFunction(b)) {
				onLoad = b;
				if (isFunction(c)) {
					onError = c;
				}
			}
		}
		let endpoint;
		try {
			endpoint = record.endpoint || (record.endpoint = compile(record.def));
			endpoint = resolved(endpoint, record);
		} catch (error) {
			// A URL function that throws: still a rejected promise, never a synchronous throw.
			return refused(ResteError('config', 'RESTe :: ' + (error && error.message ? error.message : error),
				{ endpoint: String(record.def.name), cause: error }), onError);
		}
		return pipeline.execute(endpoint, params, options, onLoad, onError);
	}

	function refused(error, onError) {
		const handle = Promise.reject(error);
		handle.abort = handle.cancel = () => false;
		handle.idempotencyKey = null;
		if (onError) {
			handle.catch(() => onError(error));
		}
		return handle;
	}

	function unknown(name) {
		return refused(ResteError('config', 'RESTe :: unknown method ' + name, { endpoint: String(name) }));
	}

	state.hasMethod = name => records.has(name);
	state.endpointOf = endpointOf;
	state.retryFor = (value, endpoint) => normalizeRetry(value, (endpoint && endpoint.retry) || state.retry);
	state.call = function (name, params, options) {
		const record = records.get(name);
		return record ? invoke(record, params, options) : unknown(name);
	};

	// ------------------------------------------------------------------ configuration

	/**
	 * One-time configuration. Everything upstream 1.x accepted still works; see the README for what is new.
	 * Calling it again replaces the previous configuration, methods included.
	 */
	reste.config = function (args) {
		const config = args || {};
		// A second config() starts over.
		records.forEach((record, name) => {
			if (reste[name] === record.fn) {
				delete reste[name];
			}
		});
		records.clear();

		state.config = config;
		state.logger = createLogger(config);
		state.queryOptions = config.query ? Object.assign({}, DEFAULT_QUERY_OPTIONS, config.query) : DEFAULT_QUERY_OPTIONS;
		state.retry = normalizeRetry(config.retry, null);
		state.pagination = normalizePagination(config.pagination, null);
		state.factory = isFunction(config.httpClient) ? config.httpClient : null;
		state.random = isFunction(config.random) ? config.random : null;

		const idempotency = config.idempotency;
		state.idempotency = {
			header: (isObject(idempotency) && idempotency.header) || 'Idempotency-Key',
			methods: isObject(idempotency) && Array.isArray(idempotency.methods) ? idempotency.methods.map(m => String(m).toUpperCase()) : []
		};
		state.keys = createKeys(isObject(idempotency) && isFunction(idempotency.generate) ? idempotency.generate : uuid);

		const cache = isObject(config.cache) ? config.cache : {};
		state.cacheDefaults = normalizeCachePolicy(isObject(cache.defaults) ? cache.defaults : true, null);
		state.cache = createCache({ maxEntries: cache.maxEntries, store: cache.store, prefix: cache.prefix });
		state.cacheScope = cache.scope === undefined ? null : cache.scope;
		state.authStatuses = Array.isArray(config.authStatuses) ? config.authStatuses.map(Number) : [401];

		state.interceptors = { request: [], response: [], error: [] };
		if (config.interceptors) {
			reste.use(config.interceptors);
		}
		if (config.validatesSecureCertificate === false) {
			state.logger.warn('validatesSecureCertificate is false: TLS certificates are NOT verified. Never ship this.');
		}

		reste.setRequestHeaders(config.requestHeaders);
		const methods = config.methods || [];
		for (let i = 0; i < methods.length; i++) {
			reste.addMethod(methods[i]);
		}
		(config.models || []).forEach(model => reste.addModel(model));
		return reste;
	};

	reste.setUrl = function (url) {
		state.config.url = url || state.config.url;
	};

	reste.getUrl = function () {
		return state.config.url;
	};

	/** Clears the cookies of a host (the base URL by default). */
	reste.clearCookies = function (url) {
		const target = url || state.config.url;
		const http = state.factory ? state.factory({}) : Ti.Network.createHTTPClient();
		if (target && http && isFunction(http.clearCookies)) {
			http.clearCookies(target);
		}
	};

	// ------------------------------------------------------------------ default headers

	/** Replaces the headers sent with every request. A value may be a function, called for each request. */
	reste.setRequestHeaders = function (headers) {
		state.headers = [];
		if (headers) {
			Object.keys(headers).forEach((name) => {
				state.headers.push({ name, value: headers[name] });
			});
		}
	};

	/** Adds or changes default headers: `{ Authorization: 'Bearer ...' }`. */
	reste.changeRequestHeader = function (header) {
		Object.keys(header || {}).forEach((name) => {
			const existing = state.headers.find(item => item.name.toLowerCase() === name.toLowerCase());
			if (existing) {
				existing.name = name;
				existing.value = header[name];
			} else {
				state.headers.push({ name, value: header[name] });
			}
		});
	};

	reste.removeRequestHeaderItem = function (name) {
		const wanted = String(name).toLowerCase();
		state.headers = state.headers.filter(item => item.name.toLowerCase() !== wanted);
	};

	/** The default headers as an object (function values are not called). */
	reste.getRequestHeaders = function () {
		const out = {};
		state.headers.forEach((item) => {
			out[item.name] = item.value;
		});
		return out;
	};

	// ------------------------------------------------------------------ methods

	reste.addMethod = function (args) {
		// Kept cheap: an app may define hundreds of methods at start and call a handful. The definition is
		// only looked at when the method is first called.
		const name = args.name;
		if (RESERVED[name] === true || records.has(name)) {
			throw new Error('RESTe :: method already defined and will be overwritten: ' + name);
		}
		if (state.logger.enabled && has(reste, name)) {
			state.logger.warn('method "' + name + '" hides RESTe\'s own ' + name + ' on this instance');
		}
		const record = { def: args, endpoint: null, variants: null, fn: null };
		record.fn = function (params, a, b, c) {
			return invoke(record, params, a, b, c);
		};
		records.set(name, record);
		reste[name] = record.fn;
	};

	reste.removeMethod = function (name) {
		const record = records.get(name);
		if (record) {
			if (reste[name] === record.fn) {
				delete reste[name];
			}
			records.delete(name);
		}
	};

	reste.hasMethod = function (name) {
		return records.has(name);
	};

	/**
	 * Calls a method by name, or sends a one-off request described inline:
	 *   api.request('getJob', { id: 7 })
	 *   api.request({ get: 'health' })
	 *   api.request({ method: 'POST', url: 'https://other.example/hook' }, { body })
	 */
	reste.request = function (target, params, a, b, c) {
		if (isObject(target)) {
			let record = adhoc ? adhoc.get(target) : null;
			if (!record) {
				record = { def: target, endpoint: null, variants: null };
				if (adhoc) {
					adhoc.set(target, record);
				}
			}
			return invoke(record, params, a, b, c);
		}
		const record = records.get(target);
		return record ? invoke(record, params, a, b, c) : unknown(target);
	};

	// ------------------------------------------------------------------ interceptors

	/**
	 * Adds interceptors: `{ request(req), response(res, req), error(err, req) }`, each a function or an array.
	 * Returns a function that removes them again.
	 */
	reste.use = function (interceptors) {
		const added = [];
		['request', 'response', 'error'].forEach((kind) => {
			[].concat(interceptors[kind] || []).forEach((fn) => {
				if (isFunction(fn)) {
					state.interceptors[kind].push(fn);
					added.push([kind, fn]);
				}
			});
		});
		return function remove() {
			added.forEach((pair) => {
				const list = state.interceptors[pair[0]];
				const index = list.indexOf(pair[1]);
				if (index !== -1) {
					list.splice(index, 1);
				}
			});
		};
	};

	// ------------------------------------------------------------------ sessions

	reste.session = {
		/** Changes every time the session is reset. */
		get generation() {
			return state.generation;
		},
		/**
		 * Ends the current session (sign-out, "session expired", a different user): responses of requests
		 * that were in flight are dropped instead of reaching collections or callbacks.
		 *
		 * options: abort (default true: abort those requests now), clearCache (default true),
		 *          resetCollections (default false: also empty every RESTe collection and singleton model).
		 */
		reset(options) {
			const settings = options || {};
			state.generation++;
			pipeline.dropStale(settings.abort !== false);
			state.episodes = Object.create(null);
			state.keys.clear();
			if (settings.clearCache !== false) {
				state.cache.clear();
			}
			data.reset(settings);
			return state.generation;
		}
	};

	/** Aborts every request in flight, or those `filter({ name, method, url, ... })` returns true for. */
	reste.abortAll = function (filter) {
		return pipeline.abortAll(filter);
	};

	reste.createAbortController = createAbortController;

	// ------------------------------------------------------------------ cache, idempotency

	reste.cache = {
		/**
		 * Drops cached responses: all of a method (`invalidate('getJobs')`), one exact request
		 * (`invalidate('getJob', { id: 7 })`), by RegExp on "GET <url>", or by function (entry, key).
		 */
		invalidate(matcher, params) {
			if (typeof matcher === 'string' && params !== undefined) {
				const endpoint = endpointOf(matcher);
				if (!endpoint) {
					return 0;
				}
				let url = fillTemplate(endpoint.template, params, endpoint.encodeParams, endpoint.name);
				url = endpoint.absolute ? url : joinUrl(state.config.url, url);
				const query = Object.assign({}, endpoint.query, params && isObject(params.query) && !endpoint.queryIsParam ? params.query : null);
				if (Object.keys(query).length) {
					url = withQuery(url, isFunction(state.config.querySerializer) ? state.config.querySerializer(query)
						: serializeQuery(query, state.queryOptions));
				}
				return state.cache.invalidate(matcher, 'GET ' + url);
			}
			return state.cache.invalidate(matcher);
		},
		clear() {
			state.cache.clear();
		},
		get size() {
			return state.cache.size;
		}
	};

	reste.idempotency = {
		key: (action, payload) => state.keys.key(action, payload),
		done: action => state.keys.done(action),
		generate: () => state.keys.generate(),
		clear: () => state.keys.clear()
	};

	// ------------------------------------------------------------------ lists, models, collections

	/**
	 * A pager over a paginated method. options: params (path parameters), query, perPage / limit,
	 * paginate (overrides the method's pagination config), idAttribute, plus any request option.
	 */
	reste.paginate = function (name, options) {
		const settings = options || {};
		const endpoint = endpointOf(name);
		if (!endpoint) {
			throw new Error('RESTe :: unknown method ' + name);
		}
		const pagination = normalizePagination(settings.paginate === undefined ? true : settings.paginate, endpoint.paginate || state.pagination);
		const requestOptions = Object.assign({}, settings.request, { fullResponse: true });
		return createPager(pagination, settings, (query) => {
			const params = Object.assign({}, settings.params);
			params.query = Object.assign({}, settings.query, query);
			return state.call(name, params, requestOptions);
		}, null);
	};

	reste.addModel = function (args) {
		return data.addModel(args);
	};

	reste.createModel = function (name, attributes) {
		return data.createModel(name, attributes);
	};

	reste.createCollection = function (name, content) {
		return data.createCollection(name, content);
	};

	/** The instance for an id of an `identity` model (created empty when not known yet). */
	reste.model = function (name, id) {
		return data.modelFor(name, id);
	};

	/**
	 * A list that follows a collection: an ordered, filtered, paginated selection of its models that picks
	 * up models arriving any other way. Its pages come from the collection's read method, or from the app's
	 * own `load(query, { signal })`. See the README, "Lists that follow a collection".
	 */
	reste.list = function (options) {
		return data.liveList(options);
	};

	/**
	 * collection.upsert(), model.replace(), model.optimistic() and collection.optimistic() as functions, for
	 * models and collections the app created itself as well as RESTe's own.
	 */
	reste.upsert = function (collection, items, options) {
		return data.upsert(collection, items, options);
	};

	reste.replace = function (model, attributes) {
		return data.replace(model, attributes);
	};

	reste.optimistic = function (target, attributes, send, options) {
		return data.optimistic(target, attributes, send, options);
	};

	/** Numbers for finding leaks: what is in flight, cached and kept per method and per model. */
	reste.inspect = function () {
		const variants = {};
		records.forEach((record, name) => {
			if (record.variants) {
				variants[name] = record.variants.size;
			}
		});
		return { inFlight: state.active.size, shared: state.inflight.size, cache: state.cache.size, variants, identity: data.identity.sizes() };
	};

	reste.collections = data.collections;
	reste.models = state.models;
	reste.identity = data.identity;

	return reste;
}

Reste.version = VERSION;
Reste.ResteError = ResteError;
Reste.createAbortController = createAbortController;
Reste.propertiesStore = propertiesStore;
Reste.fileStore = fileStore;

module.exports = Reste;
