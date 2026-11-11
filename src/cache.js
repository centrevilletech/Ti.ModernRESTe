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

/**
 * The HTTP response cache: memory first (least recently used entries are dropped past `maxEntries`), with an
 * optional persistent store behind it for entries whose policy says `persist: true`.
 *
 * A store is anything with getItem(key) -> string|null, setItem(key, string), removeItem(key) and, for
 * clear(), keys() -> string[]. `Reste.propertiesStore()` and `Reste.fileStore()` build one.
 */
function createCache(options) {
	const settings = options || {};
	const maxEntries = settings.maxEntries || 100;
	const store = settings.store || null;
	const now = settings.now || clock;
	const prefix = settings.prefix || 'reste_';
	const memory = new Map();

	function storeKey(key) {
		return prefix + hashString(key) + key.length.toString(36);
	}

	function remember(key, entry) {
		memory.delete(key);
		memory.set(key, entry);
		if (memory.size > maxEntries) {
			memory.delete(memory.keys().next().value);
		}
	}

	function hydrate(key) {
		if (!store) {
			return null;
		}
		let raw;
		try {
			raw = store.getItem(storeKey(key));
		} catch (error) {
			return null;
		}
		if (!raw) {
			return null;
		}
		try {
			const saved = JSON.parse(raw);
			if (saved.key !== key) {
				return null; // a different URL with the same hash
			}
			saved.body = undefined;
			saved.persisted = true;
			remember(key, saved);
			return saved;
		} catch (error) {
			return null;
		}
	}

	function persist(key, entry) {
		if (!store || entry.text == null) {
			return;
		}
		try {
			store.setItem(storeKey(key), JSON.stringify({
				key,
				tag: entry.tag,
				status: entry.status,
				etag: entry.etag,
				lastModified: entry.lastModified,
				headers: entry.headers,
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

	function forget(key, entry) {
		memory.delete(key);
		if (store && (!entry || entry.persisted)) {
			try {
				store.removeItem(storeKey(key));
			} catch (error) {
				// Ignored: see persist().
			}
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

	return {
		/** @returns {{entry: object, fresh: boolean, usableStale: boolean}|null} */
		lookup(key) {
			let entry = memory.get(key);
			if (entry) {
				memory.delete(key);
				memory.set(key, entry);
			} else {
				entry = hydrate(key);
			}
			if (!entry) {
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
		 * Keeps a 2xx response. Returns the entry, or null when the response may not be cached (no-store) or
		 * could never be used again (no freshness, no validator, no stale use).
		 */
		store(key, tag, policy, response) {
			const headers = response.headers;
			const times = expiry(policy, headers);
			if (!times) {
				forget(key);
				return null;
			}
			const etag = policy.etag ? headers.etag || null : null;
			const lastModified = policy.etag ? headers['last-modified'] || null : null;
			const validator = Boolean(etag || lastModified);
			if (times.expiresAt === 0 && !validator && times.staleUntil === 0 && !policy.staleIfError) {
				return null;
			}
			const entry = {
				tag,
				status: response.status,
				body: response.body,
				text: policy.persist && store ? response.text : null,
				headers,
				etag,
				lastModified,
				storedAt: now(),
				expiresAt: times.expiresAt,
				staleUntil: times.staleUntil === Infinity ? null : times.staleUntil,
				persisted: false
			};
			remember(key, entry);
			if (policy.persist) {
				persist(key, entry);
				entry.text = null; // the parsed body is what memory keeps
			}
			return entry;
		},

		/** After a 304: the stored copy is current again; take the new freshness from the 304's headers. */
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
					try {
						const saved = JSON.parse(store.getItem(storeKey(key)) || 'null');
						entry.text = saved ? saved.text : null;
					} catch (error) {
						entry.text = null;
					}
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
		 * Drops entries: all of an endpoint (its method name), those whose key matches a RegExp, those a
		 * function (entry, key) returns true for, or one exact key. Returns how many were dropped.
		 */
		invalidate(matcher, exactKey) {
			if (exactKey) {
				const entry = memory.get(exactKey) || hydrate(exactKey);
				if (entry) {
					forget(exactKey, entry);
					return 1;
				}
				return 0;
			}
			let dropped = 0;
			Array.from(memory.entries()).forEach((pair) => {
				const key = pair[0];
				const entry = pair[1];
				const hit = typeof matcher === 'string' ? entry.tag === matcher
					: matcher instanceof RegExp ? matcher.test(key)
						: isFunction(matcher) ? matcher(entry, key) : false;
				if (hit) {
					forget(key, entry);
					dropped++;
				}
			});
			return dropped;
		},

		clear() {
			memory.clear();
			if (store && isFunction(store.keys)) {
				try {
					store.keys().forEach((key) => {
						if (key.indexOf(prefix) === 0) {
							store.removeItem(key);
						}
					});
				} catch (error) {
					// Ignored: see persist().
				}
			}
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
