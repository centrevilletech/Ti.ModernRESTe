'use strict';

const { ResteError, parseRetryAfter, classifyFailure } = require('./errors');
const { fillTemplate, serializeQuery, withQuery, joinUrl, flattenFields, hasBinary } = require('./url');
const { shouldRetry, retryDelay } = require('./retry');
const { watchSignal } = require('./abort');
const transport = require('./transport');
const { isFunction, isObject, isPlainObject, has, noop, now, getPath, headerKey, hashString, later } = require('./util');

const EMPTY = Object.freeze({});
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]+/i;
const STALE = { stale: true };

/**
 * What a request resolves with when `fullResponse` is set (and what interceptors and `onLoad`'s second
 * argument see): status, headers, the parsed body, `data` (the body after `unwrap`), `meta`, and where the
 * answer came from.
 */
function Response(ctx, status, http) {
	this.ok = true;
	this.status = status;
	this.url = ctx.url;
	this.method = ctx.method;
	this.endpoint = ctx.endpoint.name;
	this.body = null;
	this.data = null;
	this.meta = null;
	this.file = null;
	this.fromCache = false;
	this.stale = false;
	this.notModified = false;
	this.unchanged = false;
	this.attempts = ctx.attempt;
	this.duration = now() - ctx.startedAt;
	this.idempotencyKey = ctx.idempotencyKey;
	this.http = http || null;
	this._headers = null;
}

Object.defineProperties(Response.prototype, {
	/** Every response header, names lower-cased. Read from the HTTP client on first use. */
	headers: {
		get() {
			if (this._headers === null) {
				this._headers = this.http ? transport.readHeaders(this.http) : {};
			}
			return this._headers;
		},
		set(value) {
			this._headers = value;
		},
		configurable: true
	},
	text: {
		get() {
			return this.http ? transport.readText(this.http) : null;
		},
		configurable: true
	},
	etag: {
		get() {
			return this.header('ETag');
		},
		configurable: true
	}
});

/** One response header, any case; null when absent. */
Response.prototype.header = function (name) {
	if (this._headers !== null || !this.http) {
		const value = (this._headers || EMPTY)[name.toLowerCase()];
		return value === undefined ? null : value;
	}
	return transport.readHeader(this.http, name);
};

function parseBody(text, http) {
	if (text === '' || text == null) {
		return null;
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		const type = String(transport.readHeader(http, 'Content-Type') || '').toLowerCase();
		if (type.indexOf('json') !== -1) {
			throw ResteError('parse', 'RESTe :: the response is not valid JSON: ' + error.message, { body: text });
		}
		return text;
	}
}

/** Titanium's Android HTTP client sends a DELETE without its body (verified on SDK 13.4.1); iOS sends it. */
function dropsBody(method) {
	return method === 'DELETE' && typeof Ti !== 'undefined' && Boolean(Ti.Platform) && Ti.Platform.osname === 'android';
}

function hasBody(body) {
	return body !== undefined && body !== null && body !== '' && !(isPlainObject(body) && Object.keys(body).length === 0);
}

function toResteError(error) {
	if (error instanceof Error) {
		return error; // a ResteError, or the app's own error thrown by an interceptor: passed on untouched
	}
	const message = error && error.message ? error.message : String(error);
	return ResteError('config', message, { cause: error });
}

/**
 * The request pipeline of one RESTe instance. `state` is the instance's private state (config, headers,
 * cache, session generation, interceptors); nothing here is shared between instances.
 */
function createPipeline(state) {
	const logger = () => state.logger;

	function execute(endpoint, params, options, onLoad, onError) {
		const ctx = {
			endpoint,
			params: params || null,
			options: options || EMPTY,
			onLoad: onLoad || null,
			onError: onError || null,
			resolve: null,
			reject: null,
			handle: null,
			method: endpoint.method,
			url: '',
			headers: null,
			body: undefined,
			timeout: 0,
			idempotencyKey: null,
			action: null,
			generation: state.generation,
			attempt: 0,
			sentSeq: 0,
			startedAt: now(),
			aborted: false,
			settled: false,
			background: false,
			hooksDone: false,
			redispatch: false,
			transport: null,
			timer: null,
			deadlineTimer: null,
			unwatch: null,
			shared: null,
			answered: false,
			overriding: false,
			elapsed: 0,
			lead: true,
			retryPolicy: undefined,
			cacheKey: null,
			cacheBase: null,
			cacheStamp: null,
			cachePolicy: null,
			cacheEntry: null,
			hookRetried: null
		};
		const handle = new Promise((resolve, reject) => {
			ctx.resolve = resolve;
			ctx.reject = reject;
		});
		ctx.handle = handle;
		handle.abort = handle.cancel = reason => abort(ctx, reason);
		handle.idempotencyKey = null;
		if (onLoad || onError || state.config.onError || endpoint.onError) {
			// The failure is delivered to a callback; the promise must not also report it as unhandled.
			handle.catch(noop);
		}
		state.active.add(ctx);

		let failure = null;
		try {
			build(ctx);
		} catch (error) {
			failure = toResteError(error);
		}
		if (failure) {
			Promise.resolve().then(() => fail(ctx, decorate(failure, ctx)));
			return handle;
		}
		handle.idempotencyKey = ctx.idempotencyKey;

		const signal = ctx.options.signal;
		if (signal) {
			if (signal.aborted) {
				Promise.resolve().then(() => abort(ctx, signal.reason));
				return handle;
			}
			ctx.unwatch = watchSignal(signal, reason => abort(ctx, reason));
		}
		const deadline = ctx.options.deadline || endpoint.deadline || state.config.deadline;
		if (deadline > 0) {
			ctx.deadlineTimer = later(() => expire(ctx, deadline), deadline);
		}
		attempt(ctx);
		return handle;
	}

	// ---------------------------------------------------------------- building

	function build(ctx) {
		const endpoint = ctx.endpoint;
		const options = ctx.options;
		const config = state.config;
		const params = ctx.params;

		if (endpoint.expects) {
			for (let i = 0; i < endpoint.expects.length; i++) {
				const name = endpoint.expects[i];
				const inBody = params && isObject(params.body) && params.body[name] != null;
				if (!inBody && !(params && params[name] != null)) {
					throw ResteError('params', 'RESTe :: missing parameter ' + name + ' for method ' + endpoint.name,
						{ missing: [name] });
				}
			}
		}

		const path = fillTemplate(endpoint.template, params, endpoint.encodeParams, endpoint.name);
		let url = endpoint.absolute ? path : joinUrl(config.url, path);

		let query = endpoint.query;
		const paramQuery = params && !endpoint.queryIsParam && isObject(params.query) ? params.query : null;
		if (paramQuery || options.query) {
			query = Object.assign({}, query, paramQuery, options.query);
		}
		if (query) {
			url = withQuery(url, isFunction(config.querySerializer) ? config.querySerializer(query)
				: serializeQuery(query, state.queryOptions));
		}
		ctx.url = url;
		ctx.body = options.body !== undefined ? options.body : (params ? params.body : undefined);
		ctx.timeout = options.timeout || endpoint.timeout || config.timeout || 10000;

		if (options.idempotencyKey) {
			ctx.idempotencyKey = options.idempotencyKey;
		} else if (endpoint.idempotent === true
			|| (endpoint.idempotent !== false && state.idempotency.methods.indexOf(ctx.method) !== -1)) {
			if (options.action) {
				ctx.action = options.action;
				ctx.idempotencyKey = state.keys.key(options.action, ctx.body);
			} else {
				ctx.idempotencyKey = state.keys.generate();
			}
		}
	}

	function resolveHeaders(ctx) {
		const out = {};
		const endpoint = ctx.endpoint;
		// Default headers (a bearer token, usually) belong to the configured API: a method with a full URL
		// on another origin gets them only when its definition says `globalHeaders: true`.
		const wanted = endpoint.globalHeaders !== undefined ? endpoint.globalHeaders
			: !endpoint.absolute || sameOrigin(ctx.url, state.config.url);
		if (wanted) {
			const globals = state.headers;
			for (let i = 0; i < globals.length; i++) {
				const value = isFunction(globals[i].value) ? globals[i].value() : globals[i].value;
				if (value != null) {
					out[globals[i].name] = value;
				}
			}
		}
		if (endpoint.headers) {
			mergeHeaders(out, endpoint.headers);
		}
		if (ctx.options.headers) {
			mergeHeaders(out, ctx.options.headers);
		}
		if (ctx.idempotencyKey) {
			out[state.idempotency.header] = ctx.idempotencyKey;
		}
		return out;
	}

	function sameOrigin(url, base) {
		const a = ORIGIN.exec(String(url || ''));
		const b = ORIGIN.exec(String(base || ''));
		return Boolean(a && b && a[0].toLowerCase() === b[0].toLowerCase());
	}

	function mergeHeaders(out, layer) {
		const names = Object.keys(layer);
		for (let i = 0; i < names.length; i++) {
			const name = names[i];
			const existing = headerKey(out, name);
			if (existing && existing !== name) {
				delete out[existing];
			}
			const value = isFunction(layer[name]) ? layer[name]() : layer[name];
			if (value == null) {
				delete out[name]; // `null` removes a header set further up
			} else {
				out[name] = value;
			}
		}
	}

	/** What interceptors, status hooks and the error mapper are told about a request. */
	function describe(ctx) {
		return {
			name: ctx.endpoint.name,
			method: ctx.method,
			url: ctx.url,
			headers: ctx.headers,
			body: ctx.body,
			timeout: ctx.timeout,
			params: ctx.params,
			attempt: ctx.attempt,
			idempotencyKey: ctx.idempotencyKey,
			meta: ctx.options.meta,
			retried: Boolean(ctx.hookRetried)
		};
	}

	function interceptorsFor(ctx, kind) {
		const global = state.interceptors[kind];
		const local = ctx.endpoint.interceptors && ctx.endpoint.interceptors[kind];
		const call = ctx.options.interceptors && ctx.options.interceptors[kind];
		if (!global.length && !local && !call) {
			return null;
		}
		return global.concat(local || [], call || []);
	}

	/** True when nothing waits for this request any more (aborted, and no de-duplicated caller shares it). */
	function dead(ctx) {
		return (ctx.aborted || ctx.settled) && !(ctx.shared && ctx.shared.refs > 0);
	}

	// ---------------------------------------------------------------- sending

	/** True when the session this request belongs to has ended. */
	function outdated(ctx) {
		return ctx.endpoint.session !== false && ctx.generation !== state.generation;
	}

	function staleError(ctx) {
		return ResteError('stale', 'RESTe :: the session ended while ' + ctx.endpoint.name + ' was in flight');
	}

	/**
	 * A request that cannot be sent (a header function, hook or interceptor threw, the session ended while it
	 * waited): it fails for its caller and for every identical request that joined it, always on a later
	 * turn, so a call never throws and never calls back before it returned.
	 */
	function abandon(ctx, error) {
		Promise.resolve().then(() => {
			if (ctx.shared) {
				settle(ctx, { error, status: 0, http: null, body: undefined });
			} else {
				failed(ctx, error);
			}
		});
	}

	function attempt(ctx) {
		if (dead(ctx)) {
			return;
		}
		if (outdated(ctx)) {
			// A retry that was waiting, or a hook's "retry", after the session ended: the next user's
			// credentials must never be put on the previous user's request.
			abandon(ctx, staleError(ctx));
			return;
		}
		ctx.attempt++;
		try {
			ctx.headers = resolveHeaders(ctx);
		} catch (error) {
			abandon(ctx, toResteError(error));
			return;
		}
		const chain = interceptorsFor(ctx, 'request');
		if (!chain) {
			afterInterceptors(ctx);
			return;
		}
		const request = describe(ctx);
		let index = 0;
		const step = (result) => {
			if (dead(ctx)) {
				return;
			}
			if (isObject(result) && result !== request) {
				Object.assign(request, result);
			}
			if (index >= chain.length) {
				ctx.method = request.method;
				ctx.url = request.url;
				ctx.headers = request.headers;
				ctx.body = request.body;
				ctx.timeout = request.timeout;
				afterInterceptors(ctx);
				return;
			}
			let returned;
			try {
				returned = chain[index++](request);
			} catch (error) {
				abandon(ctx, toResteError(error));
				return;
			}
			if (returned && isFunction(returned.then)) {
				returned.then(step, error => abandon(ctx, toResteError(error)));
			} else {
				step(returned);
			}
		};
		step();
	}

	function afterInterceptors(ctx) {
		if (ctx.hooksDone) {
			dispatch(ctx);
			return;
		}
		ctx.hooksDone = true;
		const endpoint = ctx.endpoint;
		const config = state.config;
		const beforePost = ctx.method === 'POST' ? endpoint.beforePost || config.beforePost : null;
		const beforeSend = endpoint.beforeSend || config.beforeSend;
		if (!isFunction(beforePost) && !isFunction(beforeSend)) {
			dispatch(ctx);
			return;
		}
		const run = (hook, next) => {
			if (!isFunction(hook)) {
				next();
				return;
			}
			try {
				hook(ctx.body === undefined ? {} : ctx.body, (result) => {
					if (dead(ctx)) {
						return;
					}
					if (result && result.skip) {
						// Upstream: the hook stopped the call and its value goes to the success callback.
						deliver(ctx, result, null, true);
						return;
					}
					if (result !== undefined) {
						ctx.body = result;
					}
					next();
				});
			} catch (error) {
				abandon(ctx, toResteError(error));
			}
		};
		run(beforePost, () => run(beforeSend, () => dispatch(ctx)));
	}

	function dispatch(ctx) {
		try {
			if (ctx.attempt === 1 || ctx.redispatch) {
				ctx.redispatch = false;
				if (ctx.method === 'GET' && !ctx.endpoint.download) {
					if (lookupCache(ctx)) {
						return;
					}
				}
				if (joinInflight(ctx)) {
					return;
				}
			}
		} catch (error) {
			if (ctx.settled) {
				throw error; // the caller's own callback threw while a cached answer was delivered
			}
			abandon(ctx, toResteError(error)); // a cache key function that throws
			return;
		}
		transmit(ctx);
	}

	function lookupCache(ctx) {
		const options = ctx.options;
		if (options.cache === 'no-store' || options.cache === false) {
			return false;
		}
		const policy = ctx.endpoint.cache;
		if (!policy) {
			return false;
		}
		ctx.cachePolicy = policy;
		let key;
		if (isFunction(policy.key)) {
			key = String(policy.key(describe(ctx)));
			ctx.cacheBase = key;
		} else {
			key = 'GET ' + ctx.url;
			ctx.cacheBase = key;
			if (policy.vary) {
				for (let i = 0; i < policy.vary.length; i++) {
					const name = headerKey(ctx.headers, policy.vary[i]);
					key += '\n' + policy.vary[i].toLowerCase() + ':' + (name ? ctx.headers[name] : '');
				}
			}
		}
		const scope = state.cacheScope;
		if (scope !== null && scope !== undefined) {
			key += '\nscope:' + (isFunction(scope) ? scope() : scope);
		}
		ctx.cacheKey = key;
		// Remembered from before the request is sent: an invalidation in the meantime wins over its answer.
		ctx.cacheStamp = state.cache.stamp(ctx.cacheBase, ctx.endpoint.name);
		if (options.cache === 'reload' || options.force === true) {
			return false;
		}
		const hit = state.cache.lookup(key, ctx.endpoint.name, name => requestHeader(ctx, name));
		if (!hit) {
			return false;
		}
		if (hit.fresh) {
			succeed(ctx, cachedResponse(ctx, hit.entry, false));
			return true;
		}
		ctx.cacheEntry = hit.entry;
		if (hit.usableStale && hit.entry.staleUntil !== 0) {
			// Stale-while-revalidate: answer now, refresh behind the caller's back.
			const background = Object.assign({}, ctx, {
				background: true, resolve: noop, reject: noop, onLoad: null, onError: null, unwatch: null,
				deadlineTimer: null
			});
			state.active.add(background);
			succeed(ctx, cachedResponse(ctx, hit.entry, true));
			if (!joinInflight(background)) {
				transmit(background);
			}
			return true;
		}
		return false;
	}

	/** False when the cache was invalidated for this request after it was sent: its answer is not kept. */
	function current(ctx) {
		return ctx.cacheStamp === state.cache.stamp(ctx.cacheBase, ctx.endpoint.name);
	}

	function requestHeader(ctx, name) {
		const key = headerKey(ctx.headers, name);
		return key ? ctx.headers[key] : '';
	}

	function cachedResponse(ctx, entry, stale) {
		const response = new Response(ctx, entry.status, null);
		response.fromCache = true;
		response.stale = stale;
		response._headers = entry.headers || {};
		response.body = state.cache.bodyOf(entry);
		shape(ctx, response);
		return response;
	}

	function joinInflight(ctx) {
		const endpoint = ctx.endpoint;
		const wanted = ctx.options.dedupe !== undefined ? ctx.options.dedupe
			: endpoint.dedupe !== undefined ? endpoint.dedupe : state.config.dedupe;
		if (!wanted || (ctx.method !== 'GET' && ctx.method !== 'HEAD') || endpoint.download) {
			return false;
		}
		const names = Object.keys(ctx.headers).sort();
		let key = ctx.method + ' ' + ctx.url;
		for (let i = 0; i < names.length; i++) {
			key += '\n' + names[i] + ':' + ctx.headers[names[i]];
		}
		// A conditional request may be answered 304, which only a caller holding that entry can use; and a
		// request never joins one of another session.
		key += '\nif:' + (ctx.cacheEntry ? ctx.cacheEntry.etag || ctx.cacheEntry.lastModified || '' : '');
		if (endpoint.session !== false) {
			key += '\nsession:' + ctx.generation;
		}
		const shared = state.inflight.get(key);
		if (shared) {
			shared.waiters.push(ctx);
			shared.refs++;
			ctx.shared = shared;
			ctx.lead = false;
			return true;
		}
		ctx.shared = { key, lead: ctx, waiters: [], refs: 1 };
		state.inflight.set(key, ctx.shared);
		return false;
	}

	/**
	 * The header that carries the real method when this request has to travel as POST (`methodOverride`), or
	 * null: where the platform's HTTP client would drop the body, or everywhere when the policy says `always`.
	 */
	function overrideHeader(ctx) {
		const policy = ctx.endpoint.methodOverride;
		if (!policy || policy.methods.indexOf(ctx.method) === -1) {
			return null;
		}
		return policy.always || (dropsBody(ctx.method) && hasBody(ctx.body)) ? policy.header : null;
	}

	function encodeBody(ctx, headers) {
		const endpoint = ctx.endpoint;
		let body = ctx.body;
		const typeKey = headerKey(headers, 'Content-Type');
		const type = typeKey ? String(headers[typeKey]).toLowerCase() : '';
		if (endpoint.multipart || (body !== undefined && hasBinary(body))) {
			// Titanium writes the multipart boundary itself; a Content-Type of ours would break the body.
			if (typeKey) {
				delete headers[typeKey];
			}
			return flattenFields(body);
		}
		if (endpoint.form || type.indexOf('application/x-www-form-urlencoded') === 0) {
			if (!typeKey) {
				headers['Content-Type'] = 'application/x-www-form-urlencoded';
			}
			return isObject(body) ? flattenFields(body, true) : body;
		}
		if (body === undefined) {
			if (ctx.method === 'DELETE') {
				return undefined;
			}
			body = {}; // upstream always sent a JSON body with POST, PUT and PATCH
		} else if (!ctx.overriding && !state.warnedDeleteBody && dropsBody(ctx.method)) {
			// Verified on Titanium SDK 13.4.1: the Android HTTP client sends DELETE without its body.
			state.warnedDeleteBody = true;
			logger().always(endpoint.name + ' sends a body with DELETE: Titanium\'s Android HTTP client drops it (iOS sends it). '
				+ 'Put the data in the URL, use POST, or set methodOverride.');
		}
		if (typeof body === 'string') {
			return body;
		}
		if (!typeKey) {
			headers['Content-Type'] = 'application/json';
		}
		return JSON.stringify(body);
	}

	/**
	 * The URL as it may be printed: sensitive query values replaced, and the values of path placeholders that
	 * are named like a credential (`<token>`) or that the method lists in `redact`.
	 */
	function loggedUrl(ctx) {
		const log = logger();
		const endpoint = ctx.endpoint;
		let url = ctx.url;
		if (endpoint.secretParams === undefined) {
			endpoint.secretParams = endpoint.template.names.filter(name => log.sensitive(name) || (endpoint.redact && endpoint.redact.indexOf(name) !== -1));
		}
		const params = ctx.params;
		if (params) {
			for (let i = 0; i < endpoint.secretParams.length; i++) {
				const value = params[endpoint.secretParams[i]];
				if (value !== undefined && value !== null && value !== '') {
					const text = isObject(value) ? JSON.stringify(value) : String(value);
					url = url.split(encodeURIComponent(text)).join(log.redacted).split(text).join(log.redacted);
				}
			}
		}
		return log.redactUrl(url, describe(ctx));
	}

	function transmit(ctx) {
		const endpoint = ctx.endpoint;
		const config = state.config;
		const options = ctx.options;
		const headers = ctx.headers;
		const method = ctx.method;
		let request;
		try {
			// A method this platform cannot send with its body goes out as POST and names itself in a header.
			// Only the wire sees that: retries, hooks, the log and errors keep the method that was asked for.
			const override = overrideHeader(ctx);
			ctx.overriding = Boolean(override);
			const payload = method === 'GET' || method === 'HEAD' ? undefined : encodeBody(ctx, headers);
			if (override) {
				headers[override] = method;
			}
			if (ctx.cacheEntry) {
				if (ctx.cacheEntry.etag) {
					headers['If-None-Match'] = ctx.cacheEntry.etag;
				} else if (ctx.cacheEntry.lastModified) {
					headers['If-Modified-Since'] = ctx.cacheEntry.lastModified;
				}
			}
			let file = null;
			if (endpoint.download && options.file) {
				file = typeof options.file === 'string' ? Ti.Filesystem.getFile(options.file) : options.file;
				ctx.file = file;
			}
			const progress = options.onProgress;
			const upload = method !== 'GET' && method !== 'HEAD';
			request = {
				method: override ? 'POST' : method,
				url: ctx.url,
				headers,
				payload,
				timeout: ctx.timeout,
				file,
				clientOptions: endpoint.clientOptions || config.clientOptions,
				securityManager: endpoint.securityManager || config.securityManager,
				validatesSecureCertificate: has(config, 'validatesSecureCertificate') ? config.validatesSecureCertificate : undefined,
				progressStep: options.progressStep !== undefined ? options.progressStep : config.progressStep,
				onUploadProgress: options.onUploadProgress || (upload && !endpoint.download ? progress : null),
				onDownloadProgress: options.onDownloadProgress || (!upload || endpoint.download ? progress : null)
			};
		} catch (error) {
			failed(ctx, toResteError(error));
			return;
		}

		if (outdated(ctx)) {
			// An interceptor or a hook held the request past the end of its session.
			abandon(ctx, staleError(ctx));
			return;
		}
		ctx.sentSeq = ++state.seq;
		if (config.failWhenOffline && typeof Ti !== 'undefined' && Ti.Network && Ti.Network.online === false) {
			// Asked not to wait for a timeout when the device already knows it has no connection.
			received(ctx, { status: 0, http: null, event: { error: 'The device is offline' }, elapsed: 0 });
			return;
		}
		const log = logger();
		if (log.enabled) {
			const url = loggedUrl(ctx);
			log.event('info', method + ' ' + url + (ctx.attempt > 1 ? ' (attempt ' + ctx.attempt + ')' : ''),
				{ event: 'request', endpoint: endpoint.name, method, url, attempt: ctx.attempt });
			if (log.verbose) {
				log.log('headers', log.redactHeaders(headers));
				if (ctx.body !== undefined) {
					log.log('body', log.redactBody(ctx.body));
				}
			}
		}
		try {
			ctx.transport = transport.send(state.factory, request, result => received(ctx, result));
		} catch (error) {
			received(ctx, { status: 0, http: null, event: { error: error && error.message ? error.message : String(error) }, elapsed: 0 });
		}
	}

	// ---------------------------------------------------------------- receiving

	function received(ctx, result) {
		ctx.transport = null;
		ctx.elapsed = result.elapsed;
		const status = result.status;
		let error = null;
		if (status >= 400) {
			error = httpError(ctx, result);
		} else if (status === 0 || status < 200) {
			const event = result.event || {};
			const kind = classifyFailure(event, result.elapsed, ctx.timeout);
			error = ResteError(kind, kind === 'timeout' ? 'RESTe :: the request timed out' : 'RESTe :: ' + (event.error || 'the request failed'), {
				cause: event,
				error: event.error != null ? String(event.error) : undefined,
				source: result.http,
				offline: typeof Ti !== 'undefined' && Ti.Network ? Ti.Network.online === false : false,
				code: event.code !== undefined ? event.code : 0
			});
		}
		if (error) {
			if (ctx.retryPolicy === undefined) {
				ctx.retryPolicy = ctx.options.retry !== undefined ? state.retryFor(ctx.options.retry, ctx.endpoint)
					: ctx.endpoint.retry;
			}
			const policy = ctx.retryPolicy;
			if (policy && !dead(ctx) && shouldRetry(policy, error, ctx.attempt, {
				method: ctx.method,
				idempotencyKey: ctx.idempotencyKey,
				endpointRetry: ctx.endpoint.repeatable,
				name: ctx.endpoint.name
			})) {
				const delay = retryDelay(policy, ctx.attempt, error, state.random);
				const log = logger();
				if (log.enabled) {
					log.event('info', 'retrying ' + ctx.endpoint.name + ' in ' + delay + 'ms after ' + (error.status || error.kind), {
						event: 'retry', endpoint: ctx.endpoint.name, method: ctx.method, url: loggedUrl(ctx), attempt: ctx.attempt,
						status: error.status, kind: error.kind, elapsed: ctx.elapsed, delay
					});
				}
				ctx.timer = later(() => {
					ctx.timer = null;
					attempt(ctx);
				}, delay);
				return;
			}
			settle(ctx, { error, status, http: result.http, body: undefined });
			return;
		}
		settle(ctx, { error: null, status, http: result.http, body: undefined });
	}

	function httpError(ctx, result) {
		const http = result.http;
		const text = transport.readText(http);
		let body = null;
		if (text !== '') {
			try {
				body = JSON.parse(text);
			} catch (error) {
				body = text;
			}
		}
		const headers = transport.readHeaders(http);
		const event = result.event || {};
		return ResteError('http', 'RESTe :: HTTP ' + result.status + ' from ' + ctx.endpoint.name, {
			status: result.status,
			body,
			headers,
			retryAfter: parseRetryAfter(headers['retry-after']),
			cause: event,
			error: event.error != null ? String(event.error) : 'HTTP error',
			source: http,
			code: result.status
		});
	}

	/** Hands one network outcome to the request that sent it and to every identical request that joined it. */
	function settle(ctx, outcome) {
		const shared = ctx.shared;
		if (!shared) {
			complete(ctx, outcome);
			return;
		}
		if (state.inflight.get(shared.key) === shared) {
			state.inflight.delete(shared.key);
		}
		const waiters = shared.waiters;
		ctx.shared = null;
		complete(ctx, outcome);
		for (let i = 0; i < waiters.length; i++) {
			waiters[i].shared = null;
			waiters[i].attempt = ctx.attempt;
			waiters[i].sentSeq = ctx.sentSeq;
			complete(waiters[i], outcome);
		}
	}

	function complete(ctx, outcome) {
		if (ctx.aborted || ctx.settled) {
			return;
		}
		if (ctx.endpoint.session !== false && ctx.generation !== state.generation) {
			fail(ctx, decorate(ResteError('stale', 'RESTe :: the session ended while ' + ctx.endpoint.name + ' was in flight'), ctx));
			return;
		}
		if (outcome.error) {
			failed(ctx, outcome.error);
			return;
		}
		let response;
		try {
			response = buildResponse(ctx, outcome);
		} catch (error) {
			const parsed = toResteError(error);
			parsed.status = outcome.status;
			failed(ctx, parsed);
			return;
		}
		succeed(ctx, response);
	}

	function buildResponse(ctx, outcome) {
		const endpoint = ctx.endpoint;
		const http = outcome.http;
		// Not modified: a 304, or a 200 that carries the validator we sent. iOS answers a conditional request
		// that way: its URL loading system swallows the 304 and hands back the stored 200 (verified on
		// Titanium SDK 13.4.1), and a server that ignores If-None-Match looks the same. Either way the
		// representation is the one already held, so it is not parsed again.
		const entry = ctx.cacheEntry;
		if (entry && (outcome.status === 304
			|| (outcome.status === 200 && entry.etag && transport.readHeader(http, 'ETag') === entry.etag))) {
			if (current(ctx)) {
				state.cache.revalidated(ctx.cacheKey, ctx.cacheEntry, ctx.cachePolicy, transport.readHeaders(http));
			}
			const cached = cachedResponse(ctx, ctx.cacheEntry, false);
			cached.notModified = true;
			cached.http = http;
			return cached;
		}
		const response = new Response(ctx, outcome.status, http);
		if (endpoint.download || endpoint.responseType === 'blob') {
			// A file or a blob: there is no envelope to unwrap.
			response.file = ctx.file || null;
			response.body = response.data = ctx.file || (http ? http.responseData : null);
			return response;
		}
		if (endpoint.responseType === 'text') {
			response.body = transport.readText(http);
		} else {
			if (outcome.body === undefined) {
				const text = transport.readText(http);
				const known = ctx.options.unchangedIf;
				if (known && known.url === ctx.url && known.length === text.length && known.hash === hashString(text)) {
					// Byte for byte what the caller already holds: do not even parse it.
					response.unchanged = true;
					response.materialize = function () {
						response.unchanged = false;
						response.body = parseBody(text, http);
						shape(ctx, response);
						return response;
					};
					return response;
				}
				outcome.body = parseBody(text, http);
			}
			response.body = outcome.body;
		}
		shape(ctx, response);
		if (ctx.cachePolicy && ctx.cacheKey && outcome.status >= 200 && outcome.status < 300 && current(ctx)) {
			state.cache.store(ctx.cacheKey, endpoint.name, ctx.cachePolicy, {
				status: outcome.status,
				body: response.body,
				text: ctx.cachePolicy.persist ? transport.readText(http) : null,
				headers: response.headers
			}, name => requestHeader(ctx, name));
		}
		return response;
	}

	/** Fills `data` and `meta` from the body, following the endpoint's (or the instance's) envelope settings. */
	function shape(ctx, response) {
		const endpoint = ctx.endpoint;
		const config = state.config;
		const body = response.body;
		const unwrap = endpoint.unwrap !== undefined ? endpoint.unwrap : config.unwrap;
		let data = body;
		if (unwrap && isObject(body)) {
			const inner = getPath(body, unwrap, response);
			if (inner !== undefined) {
				data = inner;
			}
		}
		response.data = data;
		const metaPath = endpoint.meta !== undefined ? endpoint.meta : config.meta;
		if (metaPath && isObject(body)) {
			const meta = getPath(body, metaPath, response);
			response.meta = meta === undefined ? null : meta;
		}
	}

	// ---------------------------------------------------------------- success

	function succeed(ctx, response) {
		const endpoint = ctx.endpoint;
		if (endpoint.invalidates && !response.fromCache) {
			for (let i = 0; i < endpoint.invalidates.length; i++) {
				state.cache.invalidate(endpoint.invalidates[i]);
			}
		}
		if (ctx.action) {
			state.keys.done(ctx.action);
		}
		const chain = interceptorsFor(ctx, 'response');
		if (!chain) {
			deliver(ctx, response.data, response, false);
			return;
		}
		const request = describe(ctx);
		let index = 0;
		let current = response;
		const step = (result) => {
			if (ctx.aborted || ctx.settled) {
				return;
			}
			if (result !== undefined && result !== null) {
				current = result;
			}
			if (index >= chain.length) {
				deliver(ctx, current.data, current, false);
				return;
			}
			let returned;
			try {
				returned = chain[index++](current, request);
			} catch (error) {
				failed(ctx, toResteError(error), true);
				return;
			}
			if (returned && isFunction(returned.then)) {
				returned.then(step, error => failed(ctx, toResteError(error), true));
			} else {
				step(returned);
			}
		};
		step();
	}

	/** Runs the upstream callback layers (global onLoad, the method's onLoad, the caller's) and resolves. */
	function deliver(ctx, data, response, skipped) {
		if (ctx.settled) {
			return;
		}
		if (ctx.background) {
			finish(ctx, response);
			if (response && !response.fromCache && isFunction(ctx.options.onUpdate)) {
				ctx.options.onUpdate(data, response);
			}
			return;
		}
		// The network part is over: a callback layer that never calls back must not keep the request listed.
		state.active.delete(ctx);
		const endpoint = ctx.endpoint;
		const config = state.config;
		const full = ctx.options.fullResponse !== undefined ? ctx.options.fullResponse
			: endpoint.fullResponse !== undefined ? endpoint.fullResponse : config.fullResponse;
		const last = (value) => {
			if (ctx.settled) {
				return;
			}
			finish(ctx, response);
			if (full && response) {
				response.data = value;
				ctx.resolve(response);
			} else {
				ctx.resolve(value);
			}
			if (ctx.onLoad) {
				ctx.onLoad(value, response);
			}
		};
		const local = isFunction(endpoint.onLoad) ? value => endpoint.onLoad(value, last, response) : last;
		try {
			if (!skipped && isFunction(config.onLoad)) {
				config.onLoad(data, local, response);
			} else {
				local(data);
			}
		} catch (error) {
			if (ctx.settled) {
				throw error; // the caller's own callback: theirs to see, as in 1.x
			}
			fail(ctx, decorate(toResteError(error), ctx)); // a hook threw before the call was answered
		}
	}

	// ---------------------------------------------------------------- failure

	function decorate(error, ctx) {
		if (error instanceof ResteError) {
			error.endpoint = ctx.endpoint.name;
			error.method = ctx.method;
			error.url = ctx.url;
			error.attempts = ctx.attempt;
			error.idempotencyKey = ctx.idempotencyKey;
		}
		return error;
	}

	/** A request failed: stale-if-error, error interceptors, then the status hooks. */
	function failed(ctx, error, afterResponse) {
		if (ctx.aborted || ctx.settled) {
			return;
		}
		decorate(error, ctx);
		if (error.kind === 'stale' || error.kind === 'cancelled') {
			fail(ctx, error); // nothing to recover, map or announce
			return;
		}
		const policy = ctx.cachePolicy;
		if (!afterResponse && policy && policy.staleIfError && ctx.cacheEntry
			&& (error.kind === 'network' || error.kind === 'timeout' || error.status >= 500)) {
			succeed(ctx, cachedResponse(ctx, ctx.cacheEntry, true));
			return;
		}
		const chain = interceptorsFor(ctx, 'error');
		if (!chain) {
			runStatusHooks(ctx, error);
			return;
		}
		const request = describe(ctx);
		let index = 0;
		let current = error;
		const step = (result) => {
			if (ctx.aborted || ctx.settled) {
				return;
			}
			if (result instanceof Error) {
				current = result;
			} else if (isObject(result) && has(result, 'resolve')) {
				deliver(ctx, result.resolve, null, false); // the interceptor recovered the request
				return;
			}
			if (index >= chain.length) {
				runStatusHooks(ctx, current);
				return;
			}
			let returned;
			try {
				returned = chain[index++](current, request);
			} catch (thrown) {
				step(thrown instanceof Error ? thrown : toResteError(thrown));
				return;
			}
			if (returned && isFunction(returned.then)) {
				returned.then(step, thrown => step(thrown instanceof Error ? thrown : toResteError(thrown)));
			} else {
				step(returned);
			}
		};
		step();
	}

	/**
	 * `onStatus` hooks fire once per event: every request that was already on its way when the hook fired
	 * (or that fails while the hook's promise is pending) joins that firing instead of causing another.
	 * A hook may answer 'retry' (or resolve to it): each of those requests is then sent once more.
	 */
	function runStatusHooks(ctx, error) {
		const hooks = state.config.onStatus;
		const status = error.status;
		const hook = hooks && error.kind === 'http' && ctx.endpoint.statusHooks !== false ? hooks[status] : null;
		if (!isFunction(hook)) {
			fail(ctx, error);
			return;
		}
		// The server has answered this request: a hook that ends the session (the usual thing to do after a
		// 401) drops what is still on its way, not the answer that made it do so.
		ctx.answered = true;
		let episode = state.episodes[status];
		if (!episode || episode.generation !== state.generation || (!episode.pending && ctx.sentSeq > episode.seq)) {
			episode = state.episodes[status] = { seq: ++state.seq, generation: state.generation, decision: undefined, pending: null };
			let answer;
			try {
				answer = hook(error, describe(ctx));
			} catch (thrown) {
				logger().always('onStatus[' + status + '] threw: ' + (thrown && thrown.message ? thrown.message : thrown));
			}
			if (answer && isFunction(answer.then)) {
				const current = episode;
				current.pending = answer.then((value) => {
					current.decision = value;
				}, () => {
					current.decision = undefined;
				}).then(() => {
					current.pending = null;
					current.seq = ++state.seq; // requests sent while the hook worked belong to this firing too
				});
			} else {
				episode.decision = answer;
			}
		}
		const decide = () => {
			if (ctx.aborted || ctx.settled) {
				return;
			}
			const decision = episode.decision;
			const again = decision === 'retry' || (isObject(decision) && decision.retry === true);
			// Sending again is allowed for a request that is safe to repeat, and for any request after a status
			// that means "refused before anything was done" (401 by default: config.authStatuses).
			const safe = ctx.method === 'GET' || ctx.method === 'HEAD' || Boolean(ctx.idempotencyKey) || ctx.endpoint.repeatable
				|| state.authStatuses.indexOf(status) !== -1;
			// (attempt() refuses a request whose session ended while the hook was working.)
			if (again && safe && !(ctx.hookRetried && ctx.hookRetried[status])) {
				(ctx.hookRetried || (ctx.hookRetried = {}))[status] = true;
				ctx.redispatch = true;
				ctx.cacheEntry = null;
				attempt(ctx);
			} else {
				fail(ctx, error);
			}
		};
		if (episode.pending) {
			episode.pending.then(decide);
		} else {
			decide();
		}
	}

	function fail(ctx, error) {
		if (ctx.settled) {
			return;
		}
		finish(ctx, null, error);
		if (ctx.background) {
			return;
		}
		const endpoint = ctx.endpoint;
		const config = state.config;
		// What the promise rejects with is the app's own error whenever it has a mapper, a cancelled or
		// stale request included: callers then deal with one error class.
		let mapped = error;
		const mapper = endpoint.mapError || config.mapError;
		if (isFunction(mapper)) {
			try {
				const result = mapper(error, describe(ctx));
				if (result !== undefined) {
					mapped = result;
				}
			} catch (thrown) {
				mapped = thrown;
			}
		}
		if (error.kind === 'cancelled' || error.kind === 'stale') {
			// Nobody asked to be told about a request they cancelled: only the promise settles, and a caller
			// who kept the handle just to abort it must not get an "unhandled rejection" for doing so.
			ctx.handle.catch(noop);
			ctx.reject(mapped);
			return;
		}
		if (ctx.action && error.kind === 'http' && error.status < 500 && error.status !== 408 && error.status !== 409
			&& error.status !== 425 && error.status !== 429) {
			state.keys.done(ctx.action); // a definite answer: repeating the action is a new action
		}
		const value = config.errorsAsObjects === false ? error.body : mapped;
		const retry = () => execute(endpoint, ctx.params, ctx.options, ctx.onLoad, ctx.onError);
		ctx.reject(mapped);
		if (isFunction(endpoint.onError)) {
			endpoint.onError(value, (recovered) => {
				if (ctx.onLoad) {
					ctx.onLoad(recovered, null);
				}
			}, retry);
		} else if (ctx.onError) {
			ctx.onError(value, retry);
		} else if (isFunction(config.onError)) {
			config.onError(value, retry);
		} else if (ctx.onLoad) {
			// 1.x passed an error nobody handles to the success callback. Apps that still ask for 1.x's error
			// values (`errorsAsObjects: false`) get that too, so a screen written for it does not wait forever.
			const toOnLoad = config.errorsToOnLoad !== undefined ? config.errorsToOnLoad : config.errorsAsObjects === false;
			if (toOnLoad) {
				ctx.onLoad(value, retry);
			} else {
				logger().always('unhandled error for ' + endpoint.name + ': ' + error.message
					+ ' (pass an error callback, set config.onError, or use the returned promise)');
			}
		}
	}

	function finish(ctx, response, error) {
		ctx.settled = true;
		state.active.delete(ctx);
		if (ctx.unwatch) {
			ctx.unwatch();
			ctx.unwatch = null;
		}
		if (ctx.deadlineTimer) {
			clearTimeout(ctx.deadlineTimer);
			ctx.deadlineTimer = null;
		}
		const log = logger();
		if (log.enabled && (error || response)) {
			const duration = now() - ctx.startedAt;
			const url = loggedUrl(ctx);
			const facts = {
				event: error ? 'error' : 'response', endpoint: ctx.endpoint.name, method: ctx.method, url, attempt: ctx.attempt,
				status: error ? error.status || 0 : response.status, kind: error ? error.kind : undefined,
				elapsed: ctx.elapsed, duration, fromCache: Boolean(response && response.fromCache),
				notModified: Boolean(response && response.notModified)
			};
			if (error) {
				log.event('warn', ctx.method + ' ' + url + ' failed: ' + (error.status || error.kind) + ' in ' + duration + 'ms', facts);
			} else {
				log.event('info', ctx.method + ' ' + url + ' ' + response.status
					+ (response.fromCache ? (response.notModified ? ' (not modified)' : response.stale ? ' (stale cache)' : ' (cache)') : '')
					+ ' in ' + duration + 'ms', facts);
			}
		}
	}

	// ---------------------------------------------------------------- cancelling

	function stopNetwork(ctx) {
		if (ctx.timer) {
			clearTimeout(ctx.timer);
			ctx.timer = null;
		}
		if (ctx.transport) {
			ctx.transport.abort();
			ctx.transport = null;
		}
	}

	function release(ctx) {
		const shared = ctx.shared;
		if (!shared) {
			stopNetwork(ctx);
			return;
		}
		shared.refs--;
		if (!ctx.lead) {
			const index = shared.waiters.indexOf(ctx);
			if (index !== -1) {
				shared.waiters.splice(index, 1);
			}
			ctx.shared = null;
		}
		if (shared.refs <= 0) {
			stopNetwork(shared.lead);
			if (state.inflight.get(shared.key) === shared) {
				state.inflight.delete(shared.key);
			}
			shared.lead.shared = null;
		}
	}

	function abort(ctx, reason) {
		if (ctx.settled || ctx.aborted) {
			return false;
		}
		ctx.aborted = true;
		release(ctx);
		const stale = reason === STALE;
		fail(ctx, decorate(ResteError(stale ? 'stale' : 'cancelled',
			stale ? 'RESTe :: the session ended while ' + ctx.endpoint.name + ' was in flight'
				: 'RESTe :: ' + ctx.endpoint.name + ' was cancelled', { reason: stale ? undefined : reason }), ctx));
		return true;
	}

	function expire(ctx, deadline) {
		if (ctx.settled || ctx.aborted) {
			return;
		}
		ctx.deadlineTimer = null;
		ctx.aborted = true;
		release(ctx);
		ctx.aborted = false;
		failed(ctx, ResteError('timeout', 'RESTe :: ' + ctx.endpoint.name + ' did not finish within ' + deadline + 'ms'));
	}

	/** Aborts every request in flight (or those `filter(info)` returns true for). Returns how many. */
	function abortAll(filter) {
		let count = 0;
		Array.from(state.active).forEach((ctx) => {
			if (!ctx.background && (!filter || filter(describe(ctx))) && abort(ctx)) {
				count++;
			} else if (ctx.background && !filter) {
				ctx.aborted = true;
				release(ctx);
				finish(ctx);
			}
		});
		return count;
	}

	/** Ends the current session: requests that belong to it are dropped (see Reste#session.reset). */
	function dropStale(abortInFlight) {
		Array.from(state.active).forEach((ctx) => {
			if (ctx.endpoint.session === false || ctx.generation === state.generation || ctx.answered) {
				return;
			}
			if (ctx.background) {
				ctx.aborted = true;
				release(ctx);
				finish(ctx);
			} else if (abortInFlight) {
				abort(ctx, STALE);
			}
		});
	}

	return { execute, abortAll, dropStale };
}

module.exports = { createPipeline, Response };
