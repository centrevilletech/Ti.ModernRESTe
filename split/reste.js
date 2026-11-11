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
	"./attributes": function (module, exports, require) {
		const { deepEqual, isObject, has } = require('./util');

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

		/** Makes a Backbone model hold exactly `next`: keys it lacks are removed; only real changes fire. */
		function replaceAttributes(model, next) {
			const gone = Object.keys(model.attributes).filter(key => !has(next, key));
			gone.forEach(key => model.unset(key));
			const diff = diffAttributes(model.attributes, next);
			if (diff) {
				model.set(diff);
			}
			return model;
		}

		module.exports = { diffAttributes, replaceAttributes };
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
					if (times.expiresAt <= now() && !validator && times.staleUntil === 0 && !policy.staleIfError) {
						forget(key, memory.get(key), tag); // what an earlier answer left is not this one's validator
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
					episode = state.episodes[status] = { seq: ++state.seq, generation: state.generation, decision: undefined, pending: null, owner: ctx };
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
						if (answer === false) {
							forget(status, episode); // not the event this hook stands for: the next response asks again
						}
					}
				}
				const decide = () => {
					if (ctx.aborted || ctx.settled) {
						return;
					}
					const decision = episode.decision;
					if (decision === false) {
						// The hook declined (a 401 that was a wrong password, not an expired session). Its firing does
						// not count: a request that had joined it while it was undecided asks the hook for itself.
						forget(status, episode);
						if (episode.owner !== ctx) {
							runStatusHooks(ctx, error);
							return;
						}
					}
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
						ctx.answered = false; // on its way again: a session reset drops it like any request in flight
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

			function forget(status, episode) {
				if (state.episodes[status] === episode) {
					delete state.episodes[status];
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
	"./index": function (module, exports, require) {
		const { ResteError } = require('./errors');
		const { compileTemplate, isAbsolute, fillTemplate, joinUrl, serializeQuery, withQuery, DEFAULT_QUERY_OPTIONS } = require('./url');
		const { createAbortController } = require('./abort');
		const { createLogger } = require('./logger');
		const { normalizeRetry } = require('./retry');
		const { createKeys } = require('./idempotency');
		const { createCache, normalizeCachePolicy, propertiesStore, fileStore } = require('./cache');
		const { createPipeline } = require('./client');
		const { replaceAttributes } = require('./attributes');
		const { isFunction, isObject, isPlainObject, has, uuid } = require('./util');

		const VERSION = '2.0.0';

		/** The members upstream 1.x defined on an instance: a method may not take one of these names. */
		const RESERVED = Object.create(null);
		['config', 'setUrl', 'getUrl', 'clearCookies', 'setRequestHeaders', 'changeRequestHeader', 'removeRequestHeaderItem',
			'addMethod', 'addModel', 'createModel', 'createCollection', 'modelConfig'].forEach((name) => {
			RESERVED[name] = true;
		});

		const VERBS = ['post', 'get', 'put', 'patch', 'delete', 'head']; // upstream's order: the last one defined wins

		const OVERRIDE_DEFAULTS = { header: 'X-HTTP-Method-Override', methods: ['DELETE'], always: false };

		/**
		 * `methodOverride`: true, false or { header, methods, always } -> the policy, layered over `base`; null when off.
		 */
		function normalizeOverride(value, base) {
			if (value === false) {
				return null;
			}
			if (value === undefined || value === null) {
				return base || null;
			}
			const policy = Object.assign({}, OVERRIDE_DEFAULTS, base, isPlainObject(value) ? value : null);
			policy.methods = [].concat(policy.methods || []).map(method => String(method).toUpperCase());
			return policy;
		}

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
				methodOverride: null,
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

			// Models, collections, lists and pagination are a good third of the library and many apps only send
			// requests: that part is loaded (in the two-file build: its file is read) when something first needs it.
			let dataLayer = null;
			let paginationDefaults; // undefined: not worked out yet
			let pagers = false;

			function data() {
				return dataLayer || (dataLayer = require('./sync').createData(reste, state));
			}

			function pagination() {
				pagers = true;
				return require('./pagination');
			}

			Object.defineProperty(state, 'pagination', {
				enumerable: true,
				get() {
					if (paginationDefaults === undefined) {
						const configured = state.config.pagination;
						paginationDefaults = configured === undefined || configured === null || configured === false ? null
							: pagination().normalizePagination(configured, null);
					}
					return paginationDefaults;
				}
			});

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
				let paginate; // worked out when a pager, a list or a collection asks for it
				const endpoint = {
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
					fullResponse: def.fullResponse,
					session: def.session,
					methodOverride: normalizeOverride(def.methodOverride, state.methodOverride),
					statusHooks: def.statusHooks,
					interceptors: def.interceptors || null,
					redact: def.redact ? [].concat(def.redact) : null,
					clientOptions: def.clientOptions,
					securityManager: def.securityManager
				};
				Object.defineProperty(endpoint, 'paginate', {
					enumerable: true,
					get() {
						if (paginate === undefined) {
							const none = (def.paginate === undefined || def.paginate === null) && (config.pagination === undefined || config.pagination === null);
							paginate = none ? null : pagination().normalizePagination(def.paginate, state.pagination);
						}
						return paginate;
					}
				});
				return endpoint;
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
				paginationDefaults = undefined;
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
				state.methodOverride = normalizeOverride(config.methodOverride, null);

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
					if (dataLayer) {
						dataLayer.reset(settings);
					}
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
				const paging = pagination().normalizePagination(settings.paginate === undefined ? true : settings.paginate, endpoint.paginate || state.pagination);
				const requestOptions = Object.assign({}, settings.request, { fullResponse: true });
				return pagination().createPager(paging, settings, (query) => {
					const params = Object.assign({}, settings.params);
					params.query = Object.assign({}, settings.query, query);
					return state.call(name, params, requestOptions);
				}, null);
			};

			reste.addModel = function (args) {
				return data().addModel(args);
			};

			reste.createModel = function (name, attributes) {
				return data().createModel(name, attributes);
			};

			reste.createCollection = function (name, content) {
				return data().createCollection(name, content);
			};

			/** The instance for an id of an `identity` model (created empty when not known yet). */
			reste.model = function (name, id) {
				return data().modelFor(name, id);
			};

			/**
			 * A list that follows a collection: an ordered, filtered, paginated selection of its models that picks
			 * up models arriving any other way. Its pages come from the collection's read method, or from the app's
			 * own `load(query, { signal })`. See the README, "Lists that follow a collection".
			 */
			reste.list = function (options) {
				return data().liveList(options);
			};

			/**
			 * collection.upsert(), model.replace(), model.optimistic() and collection.optimistic() as functions, for
			 * models and collections the app created itself as well as RESTe's own.
			 */
			reste.upsert = function (collection, items, options) {
				return data().upsert(collection, items, options);
			};

			reste.replace = function (model, attributes) {
				// A model of the app's own needs nothing of the data layer; one of RESTe's exists only once that is loaded.
				return dataLayer ? dataLayer.replace(model, attributes) : replaceAttributes(model, attributes || {});
			};

			/**
			 * Loads what is otherwise loaded on first use (models, collections, lists, pagination). Call it when the
			 * app has a quiet moment, so the first list does not pay for it.
			 */
			reste.preload = function () {
				data();
				pagination();
				return reste;
			};

			reste.optimistic = function (target, attributes, send, options) {
				return data().optimistic(target, attributes, send, options);
			};

			/** Numbers for finding leaks: what is in flight, cached and kept per method and per model. */
			reste.inspect = function () {
				const variants = {};
				records.forEach((record, name) => {
					if (record.variants) {
						variants[name] = record.variants.size;
					}
				});
				return {
					inFlight: state.active.size, shared: state.inflight.size, cache: state.cache.size, variants,
					identity: dataLayer ? dataLayer.identity.sizes() : {},
					loaded: { data: Boolean(dataLayer) || pagers } // whether this instance has needed models, collections, lists or pagers
				};
			};

			reste.models = state.models;
			Object.defineProperties(reste, {
				collections: { enumerable: true, configurable: true, get: () => data().collections },
				identity: { enumerable: true, configurable: true, get: () => data().identity }
			});

			return reste;
		}

		Reste.version = VERSION;
		Reste.ResteError = ResteError;
		Reste.createAbortController = createAbortController;
		Reste.propertiesStore = propertiesStore;
		Reste.fileStore = fileStore;

		module.exports = Reste;
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
		 * `redact`. `config.redact` adds names ({ headers, keys }), exempts names that only look like a credential
		 * ({ allow }) and takes a function for the URL ({ url }).
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
			const allowed = [].concat(redact.allow || []).map(normalize).filter(Boolean);
			const urlHook = isFunction(redact.url) ? redact.url : null;

			function sensitive(name) {
				const plain = normalize(name);
				if (!plain || allowed.indexOf(plain) !== -1) {
					return false; // nothing to judge, or a name the config says only looks like a credential
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
			if (!modules[name]) {
				// Models, collections, lists and pagination: the second file, read when one of them is first needed.
				var more = require('./reste.data');
				Object.keys(more).forEach(function (key) {
					modules[key] = more[key];
				});
			}
			var loaded = cache[name] = { exports: {} };
			modules[name](loaded, loaded.exports, load);
		}
		return cache[name].exports;
	}

	module.exports = load('./index');
}());
