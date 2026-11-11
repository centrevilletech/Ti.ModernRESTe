'use strict';

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
