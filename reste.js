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
(function () {
	'use strict';

	var cache = {};
	var modules = {
	"./abort": function (module, exports, require) {
		/**
		 * A minimal abort controller (Titanium's JavaScript engines do not ship AbortController everywhere).
		 *
		 *   const controller = Reste.createAbortController();
		 *   api.getJobs({}, { signal: controller.signal });
		 *   controller.abort();                       // every request given this signal is cancelled
		 *
		 * One controller can be handed to any number of requests (all the requests of a screen, say). A native
		 * AbortController's signal is accepted wherever a signal is.
		 */
		function createAbortController() {
			const listeners = [];
			const signal = {
				aborted: false,
				reason: undefined,
				addEventListener(type, listener) {
					if (type === 'abort' && listeners.indexOf(listener) === -1) {
						listeners.push(listener);
					}
				},
				removeEventListener(type, listener) {
					const index = type === 'abort' ? listeners.indexOf(listener) : -1;
					if (index !== -1) {
						listeners.splice(index, 1);
					}
				}
			};
			return {
				signal,
				get aborted() {
					return signal.aborted;
				},
				abort(reason) {
					if (signal.aborted) {
						return;
					}
					signal.aborted = true;
					signal.reason = reason;
					const pending = listeners.splice(0, listeners.length);
					for (let i = 0; i < pending.length; i++) {
						try {
							pending[i]({ type: 'abort', target: signal });
						} catch (error) {
							// A listener's failure must not stop the others from being cancelled.
							setTimeout(() => {
								throw error;
							}, 0);
						}
					}
				}
			};
		}

		/** Calls `onAbort` when the signal aborts; returns a function that stops listening. */
		function watchSignal(signal, onAbort) {
			if (!signal) {
				return null;
			}
			const listener = () => onAbort(signal.reason);
			signal.addEventListener('abort', listener);
			return () => signal.removeEventListener('abort', listener);
		}

		module.exports = { createAbortController, watchSignal };
	},
	"./cache": function (module, exports, require) {
		const { isFunction, isPlainObject, hashString, now: clock } = require('./util');

		const POLICY_DEFAULTS = {
			ttl: null, // ms a response stays fresh whatever the server says; null = follow Cache-Control max-age
			respectHeaders: true, // honour Cache-Control: max-age, no-store, no-cache, stale-while-revalidate
			etag: true, // revalidate stale entries with If-None-Match / If-Modified-Since
			// Answer from the stale copy and refresh behind it: true (always), ms after expiry, false (never), or null
			// to follow the server's Cache-Control: stale-while-revalidate.
			staleWhileRevalidate: null,
			staleIfError: false, // answer from the stale copy when the network fails
			persist: false, // also keep the entry in the persistent store
			vary: null, // request header names that are part of the cache key
			key: null // function (request) -> string, replaces the default key
		};

		/** `true`, 'etag', a ttl in ms or an object -> a full policy; null when caching is off. */
		function normalizeCachePolicy(value, base) {
			if (value === false || value === undefined || value === null) {
				return value === false ? null : (base || null);
			}
			const policy = Object.assign({}, POLICY_DEFAULTS, base || {});
			if (value === true) {
				return policy;
			}
			if (value === 'etag') {
				policy.respectHeaders = false;
				policy.ttl = 0;
				return policy;
			}
			if (typeof value === 'number') {
				policy.ttl = value;
				return policy;
			}
			if (isPlainObject(value)) {
				return Object.assign(policy, value);
			}
			return policy;
		}

		function parseCacheControl(value) {
			const out = {};
			if (!value) {
				return out;
			}
			String(value).split(',').forEach((part) => {
				const piece = part.trim();
				const equals = piece.indexOf('=');
				if (equals === -1) {
					out[piece.toLowerCase()] = true;
				} else {
					out[piece.slice(0, equals).trim().toLowerCase()] = piece.slice(equals + 1).trim().replace(/^"|"$/g, '');
				}
			});
			return out;
		}

		/** Response headers worth keeping on disk. Everything else (cookies above all) stays in memory only. */
		const PERSISTED_HEADERS = ['etag', 'last-modified', 'cache-control', 'content-type', 'vary'];

		/** Request headers that identify a user: a response that varies on one of them is never written to disk. */
		const CREDENTIAL_HEADER = /authorization|cookie|token|secret|key|session/i;

		/**
		 * The HTTP response cache: memory first (least recently used entries are dropped past `maxEntries`), with an
		 * optional persistent store behind it for entries whose policy says `persist: true`.
		 *
		 * A store is anything with getItem(key) -> string|null, setItem(key, string), removeItem(key) and keys() ->
		 * string[] (needed to invalidate and clear what a previous launch persisted). `Reste.fileStore()` and
		 * `Reste.propertiesStore()` build one.
		 *
		 * Every entry belongs to a tag (the method that made it). An invalidation bumps a version for what it
		 * covers; a request remembers the version from before it was sent (`stamp`) and its answer is only kept
		 * when nothing invalidated it in the meantime.
		 */
		function createCache(options) {
			const settings = options || {};
			const maxEntries = settings.maxEntries || 100;
			const store = settings.store || null;
			const now = settings.now || clock;
			const prefix = settings.prefix || 'reste_';
			const memory = new Map();
			const versions = { all: 0, tags: new Map(), keys: new Map() };

			function tagPrefix(tag) {
				return prefix + hashString(String(tag || '')) + '_';
			}

			function storeKey(key, tag) {
				return tagPrefix(tag) + hashString(key) + key.length.toString(36);
			}

			function stamp(key, tag) {
				return versions.all + ':' + (versions.tags.get(tag) || 0) + ':' + (versions.keys.get(key) || 0);
			}

			function bumpKey(key) {
				if (versions.keys.size > 500) {
					versions.keys.clear();
					versions.all++; // forget the per-key versions without making an older stamp look current
				}
				versions.keys.set(key, (versions.keys.get(key) || 0) + 1);
			}

			function remember(key, entry) {
				memory.delete(key);
				memory.set(key, entry);
				if (memory.size > maxEntries) {
					memory.delete(memory.keys().next().value);
				}
			}

			function readStored(name) {
				try {
					const raw = store.getItem(name);
					return raw ? JSON.parse(raw) : null;
				} catch (error) {
					return null;
				}
			}

			function hydrate(key, tag) {
				if (!store) {
					return null;
				}
				const saved = readStored(storeKey(key, tag));
				if (!saved || saved.key !== key) {
					return null; // nothing, or a different URL with the same hash
				}
				saved.body = undefined;
				saved.persisted = true;
				remember(key, saved);
				return saved;
			}

			function persist(key, entry) {
				if (!store || entry.text == null) {
					return;
				}
				const headers = {};
				PERSISTED_HEADERS.forEach((name) => {
					if (entry.headers && entry.headers[name] !== undefined) {
						headers[name] = entry.headers[name];
					}
				});
				try {
					store.setItem(storeKey(key, entry.tag), JSON.stringify({
						key,
						tag: entry.tag,
						status: entry.status,
						etag: entry.etag,
						lastModified: entry.lastModified,
						headers,
						vary: entry.vary,
						storedAt: entry.storedAt,
						expiresAt: entry.expiresAt,
						staleUntil: entry.staleUntil,
						text: entry.text
					}));
					entry.persisted = true;
				} catch (error) {
					// A full or read-only store must never fail a request.
				}
			}

			function forget(key, entry, tag) {
				memory.delete(key);
				if (store && (!entry || entry.persisted)) {
					try {
						store.removeItem(storeKey(key, entry ? entry.tag : tag));
					} catch (error) {
						// Ignored: see persist().
					}
				}
			}

			function storedNames() {
				if (!store || !isFunction(store.keys)) {
					return [];
				}
				try {
					return store.keys().filter(name => name.indexOf(prefix) === 0);
				} catch (error) {
					return [];
				}
			}

			function expiry(policy, headers) {
				const at = now();
				let expiresAt = 0;
				let staleUntil = 0;
				const control = policy.respectHeaders ? parseCacheControl(headers['cache-control']) : {};
				if (control['no-store']) {
					return null;
				}
				if (policy.ttl != null) {
					expiresAt = at + policy.ttl;
				} else if (!control['no-cache'] && control['max-age'] !== undefined) {
					const seconds = parseInt(control['max-age'], 10);
					if (!isNaN(seconds)) {
						expiresAt = at + seconds * 1000;
					}
				}
				if (policy.staleWhileRevalidate === true) {
					staleUntil = Infinity;
				} else if (typeof policy.staleWhileRevalidate === 'number') {
					staleUntil = Math.max(expiresAt, at) + policy.staleWhileRevalidate;
				} else if (control['stale-while-revalidate'] !== undefined && policy.staleWhileRevalidate !== false) {
					const seconds = parseInt(control['stale-while-revalidate'], 10);
					if (!isNaN(seconds)) {
						staleUntil = Math.max(expiresAt, at) + seconds * 1000;
					}
				}
				return { expiresAt, staleUntil };
			}

			/** The request headers a response says it varies on, with a hash of the value each had. */
			function varyOf(headers, requestHeader) {
				const value = headers.vary;
				if (!value) {
					return null;
				}
				const names = String(value).split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
				if (names.indexOf('*') !== -1) {
					return '*';
				}
				return names.map(name => ({ name, hash: hashString(String(requestHeader(name) || '')) }));
			}

			function sameVariant(entry, requestHeader) {
				if (!entry.vary) {
					return true;
				}
				for (let i = 0; i < entry.vary.length; i++) {
					if (hashString(String(requestHeader(entry.vary[i].name) || '')) !== entry.vary[i].hash) {
						return false;
					}
				}
				return true;
			}

			return {
				stamp,

				/**
				 * `requestHeader(name)` reads a header of the request being made: an entry whose response varied on a
				 * header that now has another value is not a hit.
				 * @returns {{entry: object, fresh: boolean, usableStale: boolean}|null}
				 */
				lookup(key, tag, requestHeader) {
					let entry = memory.get(key);
					if (entry) {
						memory.delete(key);
						memory.set(key, entry);
					} else {
						entry = hydrate(key, tag);
					}
					if (!entry || (requestHeader && !sameVariant(entry, requestHeader))) {
						return null;
					}
					const at = now();
					return {
						entry,
						fresh: entry.expiresAt > at,
						usableStale: entry.staleUntil === null || entry.staleUntil > at
					};
				},

				/**
				 * Keeps a 2xx response. Returns the entry, or null when it may not be cached (no-store, Vary: *) or
				 * could never be used again (no freshness, no validator, no stale use). The caller checks `stamp()`
				 * first: an answer to a request that was invalidated while in flight is not stored.
				 */
				store(key, tag, policy, response, requestHeader) {
					const headers = response.headers;
					const times = expiry(policy, headers);
					const vary = varyOf(headers, requestHeader || (() => ''));
					if (!times || vary === '*') {
						forget(key, memory.get(key), tag);
						return null;
					}
					const etag = policy.etag ? headers.etag || null : null;
					const lastModified = policy.etag ? headers['last-modified'] || null : null;
					const validator = Boolean(etag || lastModified);
					if (times.expiresAt === 0 && !validator && times.staleUntil === 0 && !policy.staleIfError) {
						return null;
					}
					// A response that depends on who asked is never written to disk.
					const personal = Boolean(vary && vary.some(item => CREDENTIAL_HEADER.test(item.name)));
					const toDisk = Boolean(policy.persist && store && !personal);
					const entry = {
						tag,
						status: response.status,
						body: response.body,
						text: toDisk ? response.text : null,
						headers,
						vary,
						etag,
						lastModified,
						storedAt: now(),
						expiresAt: times.expiresAt,
						staleUntil: times.staleUntil === Infinity ? null : times.staleUntil,
						persisted: false
					};
					remember(key, entry);
					if (toDisk) {
						persist(key, entry);
						entry.text = null; // the parsed body is what memory keeps
					}
					return entry;
				},

				/**
				 * After a 304: the stored copy is current again; take the new freshness from the 304's headers.
				 */
				revalidated(key, entry, policy, headers) {
					const times = expiry(policy, headers);
					if (!times) {
						forget(key, entry);
						return;
					}
					entry.expiresAt = times.expiresAt;
					entry.staleUntil = times.staleUntil === Infinity ? null : times.staleUntil;
					if (headers.etag) {
						entry.etag = headers.etag;
					}
					remember(key, entry);
					if (entry.persisted) {
						const parsed = entry.body !== undefined;
						if (entry.text == null) {
							// Entries drop their text once parsed; read it back rather than serialise the body again.
							const saved = readStored(storeKey(key, entry.tag));
							entry.text = saved ? saved.text : null;
						}
						persist(key, entry);
						if (parsed) {
							entry.text = null;
						}
					}
				},

				/** The parsed body of an entry (an entry read back from the persistent store is parsed on first use). */
				bodyOf(entry) {
					if (entry.body === undefined && entry.text != null) {
						try {
							entry.body = entry.text === '' ? null : JSON.parse(entry.text);
						} catch (error) {
							entry.body = entry.text;
						}
						entry.text = null;
					}
					return entry.body;
				},

				/**
				 * Drops entries, in memory and in the persistent store, and bumps the version that keeps requests
				 * already in flight for them from being stored when they land: all of a method (its name), one
				 * request (`baseKey`, with the method's name as `matcher`; every variant of it by scope or varying
				 * header goes), those whose key matches a RegExp, those a function (entry, key) returns true for.
				 * Returns how many were dropped.
				 */
				invalidate(matcher, baseKey) {
					let dropped = 0;
					if (baseKey) {
						bumpKey(baseKey);
						const variant = key => key === baseKey || key.indexOf(baseKey + '\n') === 0;
						Array.from(memory.entries()).forEach((pair) => {
							if (variant(pair[0])) {
								forget(pair[0], pair[1]);
								dropped++;
							}
						});
						const wantedPrefix = tagPrefix(matcher);
						storedNames().forEach((name) => {
							if (name.indexOf(wantedPrefix) !== 0) {
								return;
							}
							const saved = readStored(name);
							if (saved && saved.key && variant(saved.key)) {
								try {
									store.removeItem(name);
									dropped++;
								} catch (error) {
									// Ignored: see persist().
								}
							}
						});
						return dropped;
					}
					const byTag = typeof matcher === 'string';
					if (byTag) {
						versions.tags.set(matcher, (versions.tags.get(matcher) || 0) + 1);
					} else {
						versions.all++; // a pattern cannot be mapped to requests in flight: none of them is stored
					}
					const hit = (entry, key) => (byTag ? entry.tag === matcher
						: matcher instanceof RegExp ? matcher.test(key)
							: isFunction(matcher) ? Boolean(matcher(entry, key)) : false);
					const removed = new Set();
					Array.from(memory.entries()).forEach((pair) => {
						if (hit(pair[1], pair[0])) {
							removed.add(storeKey(pair[0], pair[1].tag));
							forget(pair[0], pair[1]);
							dropped++;
						}
					});
					// What a previous launch persisted and this one has not read yet.
					const wanted = byTag ? tagPrefix(matcher) : null;
					storedNames().forEach((name) => {
						if (removed.has(name)) {
							return;
						}
						let match = false;
						if (byTag) {
							match = name.indexOf(wanted) === 0;
						} else {
							const saved = readStored(name);
							match = Boolean(saved && saved.key && hit(saved, saved.key));
						}
						if (match) {
							try {
								store.removeItem(name);
								dropped++;
							} catch (error) {
								// Ignored: see persist().
							}
						}
					});
					return dropped;
				},

				clear() {
					versions.all++;
					memory.clear();
					storedNames().forEach((name) => {
						try {
							store.removeItem(name);
						} catch (error) {
							// Ignored: see persist().
						}
					});
				},

				get size() {
					return memory.size;
				}
			};
		}

		/** A persistent store on Ti.App.Properties: fine for small responses (settings, catalogues). */
		function propertiesStore() {
			return {
				getItem: key => Ti.App.Properties.getString(key, null),
				setItem: (key, value) => Ti.App.Properties.setString(key, value),
				removeItem: key => Ti.App.Properties.removeProperty(key),
				keys: () => Ti.App.Properties.listProperties() || []
			};
		}

		/** A persistent store of one file per entry under the app's cache directory: for larger responses. */
		function fileStore(directoryName) {
			const name = directoryName || 'reste-cache';
			let directory = null;

			function dir() {
				if (!directory) {
					directory = Ti.Filesystem.getFile(Ti.Filesystem.applicationCacheDirectory, name);
					if (!directory.exists()) {
						directory.createDirectory();
					}
				}
				return directory;
			}

			function file(key) {
				return Ti.Filesystem.getFile(dir().nativePath, key.replace(/[^a-z0-9_-]/gi, '_') + '.json');
			}

			return {
				getItem(key) {
					const target = file(key);
					if (!target.exists()) {
						return null;
					}
					const blob = target.read();
					return blob ? blob.text : null;
				},
				setItem(key, value) {
					file(key).write(value);
				},
				removeItem(key) {
					const target = file(key);
					if (target.exists()) {
						target.deleteFile();
					}
				},
				keys() {
					return (dir().getDirectoryListing() || []).map(entry => entry.replace(/\.json$/, ''));
				}
			};
		}

		module.exports = { createCache, normalizeCachePolicy, parseCacheControl, propertiesStore, fileStore };
	},
	"./client": function (module, exports, require) {
		const { ResteError, parseRetryAfter, classifyFailure } = require('./errors');
		const { fillTemplate, serializeQuery, withQuery, joinUrl, flattenFields, hasBinary } = require('./url');
		const { shouldRetry, retryDelay } = require('./retry');
		const { watchSignal } = require('./abort');
		const transport = require('./transport');
		const { isFunction, isObject, has, noop, now, getPath, headerKey, hashString, later } = require('./util');

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
				} else if (ctx.method === 'DELETE' && !state.warnedDeleteBody && typeof Ti !== 'undefined' && Ti.Platform
					&& Ti.Platform.osname === 'android') {
					// Verified on Titanium SDK 13.4.1: the Android HTTP client sends DELETE without its body.
					state.warnedDeleteBody = true;
					logger().always(endpoint.name + ' sends a body with DELETE: Titanium\'s Android HTTP client drops it (iOS sends it). '
						+ 'Put the data in the URL, or use POST.');
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
					const payload = method === 'GET' || method === 'HEAD' ? undefined : encodeBody(ctx, headers);
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
						method,
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
	},
	"./errors": function (module, exports, require) {
		/**
		 * The one error type every failed request ends in.
		 *
		 * kind      'http'       the server answered with a status outside 2xx (and not a 304 to a conditional GET)
		 *           'network'    no response: connection refused, dropped, DNS, TLS (`offline` is true when the device
		 *                        reported no connectivity)
		 *           'timeout'    no response within the request's timeout (or its deadline)
		 *           'cancelled'  aborted by the caller
		 *           'stale'      the session ended (or the user changed) while the request was in flight; its response
		 *                        was dropped
		 *           'parse'      the response claimed to be JSON and was not
		 *           'params'     a path parameter or an expected parameter is missing
		 *           'config'     the request could not be built (unknown method, no read method on a model, ...)
		 *
		 * Fields: status, body (parsed), headers (lower-cased names), url, method, endpoint (the method name),
		 * retryAfter (ms, from Retry-After), attempts, idempotencyKey, cause (the HTTP client's error event).
		 * For code written against upstream's `errorsAsObjects: true` the same values are also available under the
		 * names upstream used: success (false), code, content, error (the platform's error text), type, source.
		 */
		function ResteError(kind, message, details) {
			const error = new Error(message || kind);
			Object.setPrototypeOf(error, ResteError.prototype);
			error.kind = kind;
			error.status = 0;
			error.body = null;
			error.headers = {};
			error.url = null;
			error.method = null;
			error.endpoint = null;
			error.retryAfter = null;
			error.attempts = 0;
			error.idempotencyKey = null;
			error.offline = false;
			error.cause = null;
			if (details) {
				const keys = Object.keys(details);
				for (let i = 0; i < keys.length; i++) {
					error[keys[i]] = details[keys[i]];
				}
			}
			// Upstream's `errorsAsObjects` shape.
			error.success = false;
			error.type = 'error';
			if (error.error === undefined) {
				error.error = error.message; // HTTP and network errors keep the platform's text here, as in 1.x
			}
			if (error.code === undefined) {
				error.code = error.status;
			}
			return error;
		}

		ResteError.prototype = Object.create(Error.prototype, {
			constructor: { value: ResteError, writable: true, configurable: true },
			name: { value: 'ResteError', writable: true, configurable: true },
			content: {
				get() {
					return this.body;
				},
				set(value) {
					this.body = value;
				},
				configurable: true
			},
			isHttp: {
				get() {
					return this.kind === 'http';
				},
				configurable: true
			},
			isNetwork: {
				get() {
					return this.kind === 'network';
				},
				configurable: true
			},
			isTimeout: {
				get() {
					return this.kind === 'timeout';
				},
				configurable: true
			},
			isCancelled: {
				get() {
					return this.kind === 'cancelled' || this.kind === 'stale';
				},
				configurable: true
			},
			isStale: {
				get() {
					return this.kind === 'stale';
				},
				configurable: true
			},
			isParse: {
				get() {
					return this.kind === 'parse';
				},
				configurable: true
			},
			isOffline: {
				get() {
					return this.offline === true;
				},
				configurable: true
			}
		});

		/** A plain, loggable copy without the HTTP client and without request headers. */
		ResteError.prototype.toJSON = function () {
			return {
				name: this.name,
				kind: this.kind,
				message: this.message,
				status: this.status,
				body: this.body,
				url: this.url,
				method: this.method,
				endpoint: this.endpoint,
				retryAfter: this.retryAfter,
				attempts: this.attempts,
				offline: this.offline
			};
		};

		ResteError.is = function (value) {
			return value instanceof ResteError;
		};

		/** Retry-After as milliseconds: seconds, or an HTTP date. Null when absent or unreadable. */
		function parseRetryAfter(value, nowMs) {
			if (value == null || value === '') {
				return null;
			}
			const text = String(value).trim();
			if (/^\d+(\.\d+)?$/.test(text)) {
				return Math.round(parseFloat(text) * 1000);
			}
			const date = Date.parse(text);
			if (isNaN(date)) {
				return null;
			}
			return Math.max(0, date - (nowMs === undefined ? Date.now() : nowMs));
		}

		const TIMEOUT_PATTERN = /time(d)?[\s-]?out/i;

		/**
		 * Why a request got no response. `event` is the HTTP client's error event, `elapsed` the time since send and
		 * `timeout` the request's timeout: a failure that took at least the timeout is a timeout even when the
		 * platform's message does not say so.
		 */
		function classifyFailure(event, elapsed, timeout) {
			const message = event && event.error != null ? String(event.error) : '';
			const code = event ? event.code : undefined;
			if (TIMEOUT_PATTERN.test(message) || code === -1001) {
				return 'timeout';
			}
			if (timeout > 0 && elapsed >= timeout) {
				return 'timeout';
			}
			return 'network';
		}

		module.exports = { ResteError, parseRetryAfter, classifyFailure };
	},
	"./idempotency": function (module, exports, require) {
		/**
		 * Idempotency keys per logical action.
		 *
		 * One call is one action: it gets one key, and every automatic retry of that call reuses it. When the *user*
		 * repeats an action (taps Retry after a timeout with the form unchanged) the app wants the same key again;
		 * naming the action does that:
		 *
		 *   api.createOrder({ body }, { action: 'checkout' })    // same body -> same key until it succeeds
		 *
		 * or by hand:
		 *
		 *   const key = api.idempotency.key('checkout', body);
		 *   api.createOrder({ body }, { idempotencyKey: key }).then(() => api.idempotency.done('checkout'));
		 *
		 * A changed payload gets a new key. Keys live in memory only.
		 */
		function createKeys(generate) {
			const actions = Object.create(null); // action -> { fingerprint, key }

			function fingerprint(payload) {
				try {
					return JSON.stringify(payload === undefined ? null : payload);
				} catch (error) {
					return String(Math.random()); // not serialisable (a blob): never reuse
				}
			}

			return {
				/** The key for `action` with this payload: the previous one while the payload is unchanged. */
				key(action, payload) {
					const print = fingerprint(payload);
					const current = actions[action];
					if (current && current.fingerprint === print) {
						return current.key;
					}
					const key = generate();
					actions[action] = { fingerprint: print, key };
					return key;
				},
				/** The action reached a final answer: the next one gets a new key. */
				done(action) {
					delete actions[action];
				},
				/** A new key that belongs to no action. */
				generate() {
					return generate();
				},
				clear() {
					Object.keys(actions).forEach((action) => {
						delete actions[action];
					});
				}
			};
		}

		module.exports = { createKeys };
	},
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
	"./index": function (module, exports, require) {
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
			 * up models arriving any other way. See the README, "Lists that follow a collection".
			 */
			reste.list = function (options) {
				return data.liveList(options);
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
			let state = 'idle';
			let error = null;
			let loaded = false;
			let failedMore = false;
			let changeQueued = false;
			let destroyed = false;
			let generation = 0;
			let single = null; // the request in flight of a list without pagination

			const pager = pagination ? createPager(pagination, {
				perPage: options.perPage,
				limit: options.limit,
				content: deps.content,
				held: () => members
			}, pageQuery => deps.request(params, Object.assign({}, query, pageQuery), controller.signal),
			page => (page.unchanged ? null : mergePage(page.items))) : null;

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

			function show(models, how) {
				const unique = [];
				const incoming = new Set();
				models.forEach((model) => {
					if (!incoming.has(model)) {
						incoming.add(model);
						unique.push(model);
					}
				});
				if (how === 'replace') {
					joined = new Set();
					setMembers(unique);
				} else {
					// A page brings a model that had joined on its own: it takes its place in the page.
					const kept = members.filter(model => !(joined.has(model) && incoming.has(model)));
					unique.forEach(model => joined.delete(model));
					const have = new Set(kept);
					const fresh = unique.filter(model => !have.has(model));
					setMembers(how === 'start' ? fresh.concat(kept) : kept.concat(fresh));
				}
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
				changed();
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
				if (loaded && model && filter(model)) {
					insert(model);
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
				} else if (!member && loaded && filter(model) && inCollection(model)) {
					insert(model);
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
				if (deps.track) {
					deps.track(promise); // optimistic writes stay protected until this load has landed
				}
				return promise.then((page) => {
					if (destroyed || mine !== generation || page.discarded) {
						return page;
					}
					if (page.response && !page.unchanged) {
						show(page.models || [], how);
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
			}

			function loadSingle() {
				if (single) {
					single.abort();
				}
				const handle = single = deps.request(params, Object.assign({}, query), controller.signal);
				return handle.then((response) => {
					const page = readPage({ style: 'page', items: null, meta: null }, response, null, deps.content);
					page.response = response;
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
	"./logger": function (module, exports, require) {
		const { isFunction, isObject, isBinary } = require('./util');

		const REDACTED = '[redacted]';

		/**
		 * A name is treated as a credential when, written without case and punctuation, it contains one of these...
		 * (`X-Access-Token`, `accessToken`, `access_token`, `refreshToken`, `X-Amz-Signature`, `client_secret`)
		 */
		const SENSITIVE_PARTS = ['token', 'secret', 'password', 'passwd', 'passphrase', 'signature', 'credential', 'authorization',
			'cookie', 'apikey', 'privatekey', 'sessionid', 'otp', 'cvv', 'cvc', 'cardnumber'];

		/** ... or is one of these, or ends in "key" (`key`, `api_key`, `X-Api-Key`; not `keyword`). */
		const SENSITIVE_NAMES = ['key', 'sig', 'pin', 'pwd', 'auth', 'jwt', 'sid', 'ssn', 'code'];

		function normalize(name) {
			return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
		}

		/**
		 * The debug logger. Off unless `config.debug` is set, and then it replaces by "[redacted]" every value whose
		 * *name* looks like a credential: request headers, fields of JSON and form bodies (also when the body is a
		 * string), query parameters, and path values whose placeholder is named like one or that the method lists in
		 * `redact`. `config.redact` adds names ({ headers, keys }) and a function for the URL ({ url }).
		 *
		 * It cannot recognise a secret under an innocent name, in free text, or in a path segment it was not told
		 * about. Response headers and bodies are never printed.
		 *
		 * `config.logger(level, message, details)` replaces console output; `debug: 'verbose'` adds headers and bodies.
		 * For the lines about a request `details` holds the facts: { event: 'request' | 'retry' | 'response' | 'error',
		 * endpoint, method, url (as printed), attempt, status, kind, elapsed, duration, delay, fromCache }.
		 */
		function createLogger(config) {
			const enabled = Boolean(config.debug);
			const verbose = config.debug === 'verbose';
			const sink = isFunction(config.logger) ? config.logger : null;
			const redact = config.redact || {};
			const extra = [].concat(redact.headers || [], redact.keys || []).map(normalize).filter(Boolean);
			const urlHook = isFunction(redact.url) ? redact.url : null;

			function sensitive(name) {
				const plain = normalize(name);
				if (!plain) {
					return false;
				}
				if (SENSITIVE_NAMES.indexOf(plain) !== -1 || (plain.length > 3 && plain.slice(-3) === 'key')) {
					return true;
				}
				for (let i = 0; i < SENSITIVE_PARTS.length; i++) {
					if (plain.indexOf(SENSITIVE_PARTS[i]) !== -1) {
						return true;
					}
				}
				for (let i = 0; i < extra.length; i++) {
					if (plain.indexOf(extra[i]) !== -1) {
						return true;
					}
				}
				return false;
			}

			function redactHeaders(headers) {
				const out = {};
				if (headers) {
					const keys = Object.keys(headers);
					for (let i = 0; i < keys.length; i++) {
						out[keys[i]] = sensitive(keys[i]) ? REDACTED : headers[keys[i]];
					}
				}
				return out;
			}

			function redactValue(value, depth) {
				if (isBinary(value)) {
					return '[binary]';
				}
				if (!isObject(value) || depth > 8) {
					return value;
				}
				if (Array.isArray(value)) {
					return value.map(item => redactValue(item, depth + 1));
				}
				const out = {};
				const keys = Object.keys(value);
				for (let i = 0; i < keys.length; i++) {
					out[keys[i]] = sensitive(keys[i]) ? REDACTED : redactValue(value[keys[i]], depth + 1);
				}
				return out;
			}

			/** `a=1&password=x` with the values of sensitive names replaced. Names like `user[token]` count as `token`. */
			function redactPairs(text) {
				return text.split('&').map((pair) => {
					const equals = pair.indexOf('=');
					if (equals === -1) {
						return pair;
					}
					let name = pair.slice(0, equals);
					try {
						name = decodeURIComponent(name.replace(/\+/g, ' '));
					} catch (error) {
						// Keep the raw name.
					}
					const parts = name.split(/[[\]]+/).filter(Boolean);
					return parts.some(sensitive) ? pair.slice(0, equals + 1) + REDACTED : pair;
				}).join('&');
			}

			/** A body as it may be printed. Strings are read as JSON or as a form; anything else is not printed. */
			function redactBody(body) {
				if (typeof body !== 'string') {
					return redactValue(body, 0);
				}
				const text = body.trim();
				if (text.charAt(0) === '{' || text.charAt(0) === '[') {
					try {
						return JSON.stringify(redactValue(JSON.parse(text), 0));
					} catch (error) {
						// Not JSON after all.
					}
				}
				if (/^[^=&\s<>{}]+=[^&\s]*(&[^=&\s<>{}]+=[^&\s]*)*$/.test(text)) {
					return redactPairs(text);
				}
				return '[text, ' + body.length + ' characters]';
			}

			/** Replaces the values of sensitive query parameters in a URL, then applies `redact.url`. */
			function redactUrl(url, request) {
				let out = String(url);
				const mark = out.indexOf('?');
				if (mark !== -1) {
					const hash = out.indexOf('#', mark);
					const query = hash === -1 ? out.slice(mark + 1) : out.slice(mark + 1, hash);
					out = out.slice(0, mark + 1) + redactPairs(query) + (hash === -1 ? '' : out.slice(hash));
				}
				if (urlHook) {
					try {
						out = String(urlHook(out, request));
					} catch (error) {
						out = '[url]';
					}
				}
				return out;
			}

			function write(level, message, details) {
				if (sink) {
					sink(level, message, details);
					return;
				}
				const line = '::RESTE::' + message + (details === undefined ? '' : ' ' + safeStringify(details));
				if (level === 'warn' || level === 'error') {
					console.warn(line);
				} else {
					console.log(line);
				}
			}

			return {
				enabled,
				verbose,
				sensitive,
				redactHeaders,
				redactUrl,
				redactBody,
				redacted: REDACTED,
				log(message, details) {
					if (enabled) {
						write('info', message, details);
					}
				},
				warn(message, details) {
					if (enabled) {
						write('warn', message, details);
					}
				},
				/**
				 * A line about a request (sent, retried, answered, failed). The console gets the message; a custom
				 * logger also gets the facts, to print a line of its own or to keep request timings.
				 */
				event(level, message, facts) {
					if (enabled) {
						write(level, message, sink ? facts : undefined);
					}
				},
				/** Printed even with debug off: something the developer has to know about. */
				always(message, details) {
					write('warn', message, details);
				}
			};
		}

		function safeStringify(value) {
			try {
				return typeof value === 'string' ? value : JSON.stringify(value);
			} catch (error) {
				return String(value);
			}
		}

		module.exports = { createLogger, REDACTED };
	},
	"./merge": function (module, exports, require) {
		const { deepEqual, isObject, isFunction, later } = require('./util');
		const { ResteError } = require('./errors');

		/**
		 * The attributes of `incoming` that differ from `current`, or null when none do. Keys `incoming` lacks are
		 * left alone: a list row usually carries fewer fields than the detail of the same resource. `pending` names
		 * attributes to leave alone as well (optimistic changes in flight).
		 */
		function diffAttributes(current, incoming, pending) {
			let diff = null;
			const keys = Object.keys(incoming);
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i];
				if (pending && pending[key] > 0) {
					continue; // changed on the device, not answered by the server yet: the device's value stands
				}
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
	},
	"./retry": function (module, exports, require) {
		const { isFunction, isPlainObject } = require('./util');

		const DEFAULTS = {
			retries: 2, // sends after the first one
			baseDelay: 500,
			maxDelay: 8000,
			factor: 2,
			jitter: 0.25, // +/- 25 %
			methods: ['GET', 'HEAD'],
			statuses: [502, 503, 504],
			kinds: ['network', 'timeout'],
			retryAfter: true, // wait as long as the server's Retry-After asks (up to maxRetryAfter)
			maxRetryAfter: 30000,
			shouldRetry: null
		};

		/**
		 * Turns `true`, `false`, a number of retries or an object into a full policy, layered over `base`.
		 * Returns null when retries are off.
		 */
		function normalizeRetry(value, base) {
			if (value === false || value === 0) {
				return null;
			}
			if (value === undefined || value === null) {
				return base || null;
			}
			const policy = Object.assign({}, DEFAULTS, base || {});
			if (value === true) {
				return policy;
			}
			if (typeof value === 'number') {
				policy.retries = value;
				return policy;
			}
			if (isPlainObject(value)) {
				Object.assign(policy, value);
				return policy;
			}
			return policy;
		}

		/**
		 * Whether a request may be sent again at all: GET / HEAD, a request that carries an idempotency key, or an
		 * endpoint that says repeating it is harmless (`retry: true` or a retry object on the method definition).
		 */
		function isRepeatable(policy, request) {
			if (request.endpointRetry) {
				return true;
			}
			if (request.idempotencyKey) {
				return true;
			}
			return policy.methods.indexOf(request.method) !== -1;
		}

		/**
		 * Whether to send again after `error` on attempt number `attempt` (1 is the first send).
		 * Never for a cancelled or stale request, never for a request that is not safe to repeat.
		 */
		function shouldRetry(policy, error, attempt, request) {
			if (!policy || attempt > policy.retries) {
				return false;
			}
			if (error.kind === 'cancelled' || error.kind === 'stale' || error.kind === 'params' || error.kind === 'config') {
				return false;
			}
			if (!isRepeatable(policy, request)) {
				return false;
			}
			if (isFunction(policy.shouldRetry)) {
				const verdict = policy.shouldRetry(error, attempt, request);
				if (verdict === true || verdict === false) {
					return verdict;
				}
			}
			if (error.kind === 'http') {
				return policy.statuses.indexOf(error.status) !== -1;
			}
			return policy.kinds.indexOf(error.kind) !== -1;
		}

		/**
		 * Milliseconds to wait before attempt `attempt + 1`: base * factor^(attempt-1), capped, with jitter; the
		 * server's Retry-After wins when it asks for longer (itself capped by maxRetryAfter).
		 */
		function retryDelay(policy, attempt, error, random) {
			const base = Math.min(policy.maxDelay, policy.baseDelay * Math.pow(policy.factor, attempt - 1));
			const spread = policy.jitter > 0 ? 1 - policy.jitter + (random || Math.random)() * policy.jitter * 2 : 1;
			let delay = Math.round(base * spread);
			if (policy.retryAfter && error && error.retryAfter != null) {
				delay = Math.max(delay, Math.min(error.retryAfter, policy.maxRetryAfter));
			}
			return delay;
		}

		module.exports = { normalizeRetry, shouldRetry, retryDelay, isRepeatable, RETRY_DEFAULTS: DEFAULTS };
	},
	"./sync": function (module, exports, require) {
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
	},
	"./transport": function (module, exports, require) {
		const { isObject, lowerKeys, now } = require('./util');

		/** HTTP client creation properties RESTe passes through untouched when they are configured. */
		const CLIENT_OPTIONS = [
			'autoEncodeUrl', 'autoRedirect', 'cache', 'domain', 'enableKeepAlive', 'password', 'tlsVersion', 'username',
			'withCredentials'
		];

		function defaultFactory(options) {
			return Ti.Network.createHTTPClient(options);
		}

		/**
		 * One HTTP exchange on Titanium's HTTP client.
		 *
		 * request: { method, url, headers, payload, timeout, file, clientOptions, securityManager,
		 *            validatesSecureCertificate, onUploadProgress, onDownloadProgress }
		 * done({ status, http, event, elapsed }) is called exactly once, and never after abort().
		 *
		 * @returns {{abort: function(): void, http: object}}
		 */
		function send(factory, request, done) {
			const options = { timeout: request.timeout };
			if (request.securityManager) {
				// Creation-only on Android, so it has to be part of the creation dictionary.
				options.securityManager = request.securityManager;
			}
			if (request.validatesSecureCertificate !== undefined) {
				options.validatesSecureCertificate = request.validatesSecureCertificate;
			}
			const extra = request.clientOptions;
			if (extra) {
				for (let i = 0; i < CLIENT_OPTIONS.length; i++) {
					if (extra[CLIENT_OPTIONS[i]] !== undefined) {
						options[CLIENT_OPTIONS[i]] = extra[CLIENT_OPTIONS[i]];
					}
				}
			}

			const http = (factory || defaultFactory)(options);
			const started = now();
			let finished = false;

			function finish(event) {
				if (finished) {
					return;
				}
				finished = true;
				let status = 0;
				try {
					status = http.status || 0;
				} catch (error) {
					status = 0;
				}
				done({ status, http, event: event || null, elapsed: now() - started });
			}

			http.onload = finish;
			http.onerror = finish;
			if (request.onUploadProgress) {
				http.onsendstream = stepped(request.onUploadProgress, request.progressStep, () => finished);
			}
			if (request.onDownloadProgress) {
				http.ondatastream = stepped(request.onDownloadProgress, request.progressStep, () => finished);
			}

			http.open(request.method, request.url);

			const headers = request.headers;
			const names = Object.keys(headers);
			for (let i = 0; i < names.length; i++) {
				http.setRequestHeader(names[i], headers[names[i]]);
			}
			if (request.file) {
				http.file = request.file;
			}

			if (request.payload === undefined) {
				http.send();
			} else {
				http.send(request.payload);
			}

			return {
				http,
				abort() {
					if (finished) {
						return;
					}
					finished = true;
					try {
						http.abort();
					} catch (error) {
						// Aborting a client that never connected throws on some platforms; the request is over anyway.
					}
				}
			};
		}

		/**
		 * A progress listener that calls `report` only when progress moved by at least `step` (1 % by default), and
		 * always for the end. Titanium's Android client reports every few hundred bytes: thousands of events for one
		 * photo, each of which would otherwise reach the app's UI code.
		 */
		function stepped(report, step, isFinished) {
			const least = step === undefined || step === null ? 0.01 : step;
			let last = -1;
			return function (event) {
				if (isFinished()) {
					return;
				}
				const value = clamp(event && event.progress);
				if (value === last || (value < 1 && last >= 0 && value - last < least && value >= last)) {
					return;
				}
				last = value;
				report(value);
			};
		}

		function clamp(progress) {
			const value = Number(progress);
			if (!(value > 0)) {
				return 0; // Titanium reports -1 while the total size is unknown
			}
			return value > 1 ? 1 : value;
		}

		/** Every response header with a lower-cased name, from whichever accessor the platform offers. */
		function readHeaders(http) {
			let source = null;
			try {
				source = http.responseHeaders;
			} catch (error) {
				source = null;
			}
			if (isObject(source)) {
				return lowerKeys(source);
			}
			let raw = null;
			try {
				raw = typeof http.getAllResponseHeaders === 'function' ? http.getAllResponseHeaders() : http.allResponseHeaders;
			} catch (error) {
				raw = null;
			}
			const out = {};
			if (typeof raw === 'string') {
				raw.split(/\r?\n/).forEach((line) => {
					const colon = line.indexOf(':');
					if (colon > 0) {
						out[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
					}
				});
			}
			return out;
		}

		/** One response header, without reading them all. */
		function readHeader(http, name) {
			try {
				const value = http.getResponseHeader(name);
				if (value != null) {
					return value;
				}
				return http.getResponseHeader(name.toLowerCase());
			} catch (error) {
				return null;
			}
		}

		function readText(http) {
			try {
				const text = http.responseText;
				return text == null ? '' : text;
			} catch (error) {
				return '';
			}
		}

		module.exports = { send, readHeaders, readHeader, readText, stepped, CLIENT_OPTIONS };
	},
	"./url": function (module, exports, require) {
		const { ResteError } = require('./errors');
		const { isObject, isBinary } = require('./util');

		const PLACEHOLDER = /<(\w+)>/g;
		const ABSOLUTE = /^[a-z][a-z0-9+.-]*:\/\//i;

		/**
		 * Splits `jobs/<job>/offers/<offer>` once into literals and names so a call only joins strings.
		 * @returns {{source: string, literals: string[], names: string[]}}
		 */
		function compileTemplate(source) {
			const literals = [];
			const names = [];
			const inQuery = []; // per placeholder: it sits after the "?" (an empty value is fine there)
			let last = 0;
			let match;
			PLACEHOLDER.lastIndex = 0;
			while ((match = PLACEHOLDER.exec(source)) !== null) {
				literals.push(source.slice(last, match.index));
				names.push(match[1]);
				inQuery.push(source.lastIndexOf('?', match.index) !== -1);
				last = match.index + match[0].length;
			}
			literals.push(source.slice(last));
			return { source, literals, names, inQuery };
		}

		/**
		 * Fills a compiled template. Objects are sent as JSON, as upstream did. Throws a ResteError('params') naming
		 * every placeholder that has no value: null and undefined anywhere, and an empty string in the path (where
		 * it would turn `things/<id>` into the URL of the whole list), but not in the query string.
		 */
		function fillTemplate(template, params, encode, endpointName) {
			const names = template.names;
			if (names.length === 0) {
				return template.source;
			}
			const literals = template.literals;
			let out = literals[0];
			let missing = null;
			for (let i = 0; i < names.length; i++) {
				let value = params ? params[names[i]] : undefined;
				if (value === null || value === undefined || (value === '' && !template.inQuery[i])) {
					(missing || (missing = [])).push(names[i]);
				} else {
					if (isObject(value)) {
						value = JSON.stringify(value);
					}
					out += encode ? encodeURIComponent(value) : value;
				}
				out += literals[i + 1];
			}
			if (missing) {
				throw ResteError('params', 'RESTe :: missing parameter/s ' + missing.map(name => '<' + name + '>').join(',')
					+ ' for method ' + endpointName, { endpoint: endpointName, missing });
			}
			return out;
		}

		function encodePair(key, value) {
			return encodeURIComponent(key) + '=' + encodeURIComponent(value);
		}

		function scalar(value) {
			if (value instanceof Date) {
				return value.toISOString();
			}
			return value;
		}

		function appendQuery(parts, key, value, options) {
			if (value === undefined || value === null) {
				if (value === null && options.nulls === 'empty') {
					parts.push(encodeURIComponent(key) + '=');
				}
				return;
			}
			if (value === '' && options.skipEmptyString) {
				return;
			}
			if (Array.isArray(value)) {
				const format = options.arrayFormat;
				if (format === 'comma') {
					const kept = value.filter(item => item !== null && item !== undefined).map(scalar);
					if (kept.length) {
						parts.push(encodePair(key, kept.join(',')));
					}
					return;
				}
				for (let i = 0; i < value.length; i++) {
					const item = value[i];
					if (isObject(item) && !(item instanceof Date)) {
						appendQuery(parts, key + '[' + i + ']', item, options);
					} else if (format === 'repeat') {
						appendQuery(parts, key, item, options);
					} else if (format === 'indices') {
						appendQuery(parts, key + '[' + i + ']', item, options);
					} else {
						appendQuery(parts, key + '[]', item, options);
					}
				}
				return;
			}
			if (value instanceof Date) {
				parts.push(encodePair(key, value.toISOString()));
				return;
			}
			if (isObject(value)) {
				const keys = Object.keys(value);
				for (let i = 0; i < keys.length; i++) {
					appendQuery(parts, key + '[' + keys[i] + ']', value[keys[i]], options);
				}
				return;
			}
			parts.push(encodePair(key, value));
		}

		const DEFAULT_QUERY_OPTIONS = { arrayFormat: 'brackets', nulls: 'skip', skipEmptyString: false };

		/**
		 * `{ status: 'open', tags: ['a', 'b'], page: 2, q: null }` -> `status=open&tags%5B%5D=a&tags%5B%5D=b&page=2`.
		 * null and undefined are left out; arrays use `key[]=` unless `arrayFormat` says 'repeat', 'indices' or 'comma';
		 * nested objects use `key[child]=`; booleans are true / false; dates are ISO 8601.
		 */
		function serializeQuery(query, options) {
			if (!query) {
				return '';
			}
			const settings = options || DEFAULT_QUERY_OPTIONS;
			const parts = [];
			const keys = Object.keys(query);
			for (let i = 0; i < keys.length; i++) {
				appendQuery(parts, keys[i], query[keys[i]], settings);
			}
			return parts.join('&');
		}

		function withQuery(url, queryString) {
			if (!queryString) {
				return url;
			}
			const hash = url.indexOf('#');
			const base = hash === -1 ? url : url.slice(0, hash);
			const fragment = hash === -1 ? '' : url.slice(hash);
			const separator = base.indexOf('?') === -1 ? '?' : (/[?&]$/.test(base) ? '' : '&');
			return base + separator + queryString + fragment;
		}

		function isAbsolute(url) {
			return ABSOLUTE.test(url);
		}

		/** Base URL + path with exactly one slash between them; an absolute path is returned as is. */
		function joinUrl(base, path) {
			if (!base || isAbsolute(path)) {
				return path;
			}
			if (!path) {
				return base;
			}
			const baseSlash = base.charAt(base.length - 1) === '/';
			const pathSlash = path.charAt(0) === '/';
			if (baseSlash && pathSlash) {
				return base + path.slice(1);
			}
			if (!baseSlash && !pathSlash && path.charAt(0) !== '?') {
				return base + '/' + path;
			}
			return base + path;
		}

		/**
		 * Flattens a body for multipart or form encoding, because Titanium's HTTP client takes one flat dictionary:
		 * `{ photos: [a, b], meta: { note: 'x' } }` -> `{ 'photos[0]': a, 'photos[1]': b, 'meta[note]': 'x' }`.
		 * A key that already ends in `[]` keeps its name: `'photos[]': [a, b]` -> `photos[0]`, `photos[1]`.
		 * null and undefined are left out; booleans and numbers become strings (with `keepPrimitives`, top-level
		 * ones are passed as they are); binary values pass through.
		 */
		function flattenFields(body, keepPrimitives) {
			const out = {};
			if (!body) {
				return out;
			}
			const keys = Object.keys(body);
			for (let i = 0; i < keys.length; i++) {
				const value = body[keys[i]];
				if (keepPrimitives && (typeof value === 'number' || typeof value === 'boolean')) {
					out[keys[i]] = value; // a flat form body reaches the HTTP client exactly as 1.x passed it
				} else {
					flattenField(out, keys[i], value);
				}
			}
			return out;
		}

		function flattenField(out, key, value) {
			if (value === null || value === undefined) {
				return;
			}
			if (isBinary(value)) {
				out[key] = value;
			} else if (Array.isArray(value)) {
				const stem = key.slice(-2) === '[]' ? key.slice(0, -2) : key;
				for (let i = 0; i < value.length; i++) {
					flattenField(out, stem + '[' + i + ']', value[i]);
				}
			} else if (value instanceof Date) {
				out[key] = value.toISOString();
			} else if (isObject(value)) {
				const keys = Object.keys(value);
				for (let i = 0; i < keys.length; i++) {
					flattenField(out, key + '[' + keys[i] + ']', value[keys[i]]);
				}
			} else if (typeof value === 'boolean') {
				out[key] = value ? 'true' : 'false';
			} else {
				out[key] = typeof value === 'string' ? value : String(value);
			}
		}

		/** True when any top-level or nested value of a body is a Ti.Blob / File / Buffer. */
		function hasBinary(body) {
			if (!isObject(body)) {
				return false;
			}
			if (isBinary(body)) {
				return true;
			}
			const keys = Object.keys(body);
			for (let i = 0; i < keys.length; i++) {
				const value = body[keys[i]];
				if (isBinary(value) || (isObject(value) && !(value instanceof Date) && hasBinary(value))) {
					return true;
				}
			}
			return false;
		}

		module.exports = {
			compileTemplate,
			fillTemplate,
			serializeQuery,
			withQuery,
			isAbsolute,
			joinUrl,
			flattenFields,
			hasBinary,
			DEFAULT_QUERY_OPTIONS
		};
	},
	"./util": function (module, exports, require) {
		/* Small helpers shared by every module. No dependencies, nothing Titanium specific. */

		const hasOwn = Object.prototype.hasOwnProperty;
		const toString = Object.prototype.toString;

		function has(object, key) {
			return object != null && hasOwn.call(object, key);
		}

		function isFunction(value) {
			return typeof value === 'function';
		}

		function isObject(value) {
			return value !== null && typeof value === 'object';
		}

		function isPlainObject(value) {
			if (!isObject(value) || toString.call(value) !== '[object Object]') {
				return false;
			}
			const proto = Object.getPrototypeOf(value);
			return proto === null || proto === Object.prototype;
		}

		function noop() {}

		function now() {
			return Date.now();
		}

		/** Reads `a.b.c` (or a function of the object) from an object; undefined when a step is missing. */
		function getPath(object, path, extra) {
			if (path == null || path === '') {
				return object;
			}
			if (isFunction(path)) {
				return path(object, extra);
			}
			if (!isObject(object)) {
				return undefined;
			}
			if (has(object, path)) {
				return object[path];
			}
			if (path.indexOf('.') === -1) {
				return undefined;
			}
			const steps = path.split('.');
			let value = object;
			for (let i = 0; i < steps.length; i++) {
				if (!isObject(value)) {
					return undefined;
				}
				value = value[steps[i]];
			}
			return value;
		}

		/** Structural equality for JSON-like values (what an API sends back). */
		function deepEqual(a, b) {
			if (a === b) {
				return true;
			}
			if (!isObject(a) || !isObject(b)) {
				// NaN never arrives in JSON, but a model may hold one.
				return a !== a && b !== b;  
			}
			const aIsArray = Array.isArray(a);
			if (aIsArray !== Array.isArray(b)) {
				return false;
			}
			if (aIsArray) {
				if (a.length !== b.length) {
					return false;
				}
				for (let i = 0; i < a.length; i++) {
					if (!deepEqual(a[i], b[i])) {
						return false;
					}
				}
				return true;
			}
			if (a instanceof Date || b instanceof Date) {
				return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
			}
			const keys = Object.keys(a);
			if (keys.length !== Object.keys(b).length) {
				return false;
			}
			for (let i = 0; i < keys.length; i++) {
				const key = keys[i];
				if (!hasOwn.call(b, key) || !deepEqual(a[key], b[key])) {
					return false;
				}
			}
			return true;
		}

		/** 32-bit FNV-1a of a string, as 8 hex characters. Used for cache file names and unchanged-body checks. */
		function hashString(text) {
			let hash = 0x811c9dc5;
			for (let i = 0; i < text.length; i++) {
				hash ^= text.charCodeAt(i);
				hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
			}
			return ('0000000' + hash.toString(16)).slice(-8);
		}

		/** A random RFC 4122 version 4 UUID; the platform's generator when Titanium is present. */
		function uuid() {
			if (typeof Ti !== 'undefined' && Ti.Platform && isFunction(Ti.Platform.createUUID)) {
				return String(Ti.Platform.createUUID()).toLowerCase();
			}
			let out = '';
			for (let i = 0; i < 36; i++) {
				if (i === 8 || i === 13 || i === 18 || i === 23) {
					out += '-';
				} else if (i === 14) {
					out += '4';
				} else {
					const random = Math.random() * 16 | 0;
					out += (i === 19 ? (random & 0x3) | 0x8 : random).toString(16);
				}
			}
			return out;
		}

		/** True for the values Titanium sends as a file part: Ti.Blob, Ti.Filesystem.File, Ti.Buffer. */
		function isBinary(value) {
			if (!isObject(value)) {
				return false;
			}
			const apiName = value.apiName;
			return apiName === 'Ti.Blob' || apiName === 'Ti.Filesystem.File' || apiName === 'Ti.Buffer';
		}

		/** Lower-cases the keys of a header object. */
		function lowerKeys(object) {
			const out = {};
			if (object) {
				const keys = Object.keys(object);
				for (let i = 0; i < keys.length; i++) {
					out[keys[i].toLowerCase()] = object[keys[i]];
				}
			}
			return out;
		}

		/** Finds a header by name whatever its case; returns the key in use or null. */
		function headerKey(headers, name) {
			if (has(headers, name)) {
				return name;
			}
			const wanted = name.toLowerCase();
			const keys = Object.keys(headers);
			for (let i = 0; i < keys.length; i++) {
				if (keys[i].toLowerCase() === wanted) {
					return keys[i];
				}
			}
			return null;
		}

		/** Calls `fn` on a later turn of the event loop. */
		function later(fn, ms) {
			return setTimeout(fn, ms || 0);
		}

		module.exports = {
			has,
			isFunction,
			isObject,
			isPlainObject,
			noop,
			now,
			getPath,
			deepEqual,
			hashString,
			uuid,
			isBinary,
			lowerKeys,
			headerKey,
			later
		};
	}
	};

	function load(name) {
		if (!cache[name]) {
			var loaded = cache[name] = { exports: {} };
			modules[name](loaded, loaded.exports, load);
		}
		return cache[name].exports;
	}

	module.exports = load('./index');
}());
