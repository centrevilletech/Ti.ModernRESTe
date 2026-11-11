/**
 * The on-device checks: RESTe on Titanium's real HTTP client, against test/server/server.js.
 *
 * The Node suite proves the library's logic; these prove what only a device can: how the platform's HTTP
 * client reports timeouts, dropped connections, 304s, headers and progress, that multipart bodies arrive
 * intact, that Alloy's own Backbone and data binding work with the collections.
 *
 * There are 47 checks in this file; run() adds one more that needs the app's bound TableView, so a run in
 * the example app reports 48.
 *
 * Every check prints one line to the log, so a run can be read with `adb logcat` or the simulator's log:
 *   RESTE-CHECK PASS <name> [detail]
 *   RESTE-CHECK FAIL <name>: <reason>
 *   RESTE-BENCH <name> <value>
 *   RESTE-CHECK DONE pass=<n> fail=<n> platform=<name> sdk=<version>
 */
const { Reste, baseConfig, SERVER, METHODS } = require('api');

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || 'assertion failed');
	}
}

/** JSON with object keys in a fixed order, so two objects with the same content compare equal. */
function stable(value) {
	return JSON.stringify(value, (key, item) => {
		if (item && typeof item === 'object' && !Array.isArray(item)) {
			const sorted = {};
			Object.keys(item).sort().forEach((name) => {
				sorted[name] = item[name];
			});
			return sorted;
		}
		return item;
	});
}

function equal(actual, expected, what) {
	if (stable(actual) !== stable(expected)) {
		throw new Error((what || 'value') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
	}
}

function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('expected a rejection');
}

const EXTRA_METHODS = [
	{ name: 'reset', post: '_reset', session: false },
	{ name: 'stats', get: '_stats', unwrap: false, dedupe: false },
	{ name: 'echo', post: 'echo', unwrap: false },
	{ name: 'echoGet', get: 'echo?p=<p>', unwrap: false },
	{ name: 'echoDelete', delete: 'echo', unwrap: false },
	{ name: 'echoForm', post: 'echo', form: true, unwrap: false },
	{ name: 'empty', get: 'empty' },
	{ name: 'invalid', post: 'invalid' },
	{ name: 'limited', get: 'limited', retry: false },
	{ name: 'brokenJson', get: 'broken-json', retry: false },
	{ name: 'slow', get: 'slow', retry: false },
	{ name: 'drop', get: 'drop', retry: false },
	{ name: 'flaky', get: 'flaky' },
	{ name: 'order', post: 'orders', idempotent: true },
	{ name: 'catalog', get: 'catalog', cache: 'etag' },
	{ name: 'catalogPersisted', get: 'catalog', cache: { persist: true, ttl: 0 } },
	{ name: 'bumpCatalog', post: 'catalog/bump' },
	{ name: 'settings', get: 'settings', cache: true },
	{ name: 'secure', get: 'secure' },
	{ name: 'rotate', post: 'token/rotate', statusHooks: false, session: false },
	{ name: 'upgrade', get: 'upgrade' },
	{ name: 'big', get: 'big' },
	{ name: 'feed', get: 'feed', unwrap: false, paginate: { style: 'cursor', cursorParam: 'cursor', nextCursor: 'next_cursor', items: 'items', order: 'desc' } }
];

/** A fresh instance for one check. Its collections are private (not in Alloy.Collections). */
function make(extra) {
	const api = new Reste();
	api.config(baseConfig(Object.assign({ methods: METHODS.concat(EXTRA_METHODS) }, extra)));
	return api;
}

function blobOf(bytes, fill) {
	const buffer = Ti.createBuffer({ length: bytes });
	buffer.fill(fill === undefined ? 66 : fill);
	return buffer.toBlob();
}

/** Models for checks that need collections; names are unique per call so checks do not share state. */
let modelSerial = 0;
function withModels(extra, collectionExtra) {
	const suffix = 'Check' + (++modelSerial);
	const names = { things: 'things' + suffix, mine: 'mine' + suffix, items: 'items' + suffix, big: 'big' + suffix };
	const api = make(Object.assign({
		models: [{
			name: 'thing' + suffix,
			read: 'getThing',
			create: 'createThing',
			update: 'updateThing',
			patch: 'patchThing',
			delete: 'deleteThing',
			content: 'data',
			identity: true,
			collections: [
				Object.assign({ name: names.things, read: 'getThings', content: 'data', merge: true }, collectionExtra),
				{ name: names.mine, read: 'getThings', content: 'data', merge: true }
			]
		}, {
			name: 'item' + suffix,
			collections: [
				{ name: names.items, read: 'getItems', content: 'data', merge: true },
				Object.assign({ name: names.big, read: 'big', content: 'data', merge: true }, collectionExtra)
			]
		}]
	}, extra));
	return {
		api,
		things: Alloy.Collections[names.things],
		mine: Alloy.Collections[names.mine],
		items: Alloy.Collections[names.items],
		big: Alloy.Collections[names.big],
		createThing: attributes => api.createModel('thing' + suffix, attributes),
		cleanup() {
			Object.keys(names).forEach(key => delete Alloy.Collections[names[key]]);
		}
	};
}

function bindingEvents() {
	return /^0\./.test(Backbone.VERSION) ? 'fetch destroy change add remove reset' : 'fetch destroy change add remove reset sort';
}

// ---------------------------------------------------------------- the checks

const CHECKS = [];
function check(name, run) {
	CHECKS.push({ name, run });
}

check('GET returns parsed JSON', async () => {
	equal(await make().health(), { ok: true });
});

check('POST sends a JSON body with its content type', async () => {
	const echoed = await make().echo({ body: { name: 'Ünï ✓', list: [1, 2], nested: { ok: true } } });
	equal(echoed.json, { name: 'Ünï ✓', list: [1, 2], nested: { ok: true } }, 'body');
	assert(/^application\/json/.test(echoed.headers['content-type']), 'content type was ' + echoed.headers['content-type']);
	return echoed.headers['content-type'];
});

check('query strings: arrays, encoding, nulls left out', async () => {
	const echoed = await make().echo({ body: {}, query: { tags: ['a', 'b c'], q: 'x&y=z', none: null, zero: 0 } });
	equal(echoed.rawQuery, '?tags%5B%5D=a&tags%5B%5D=b%20c&q=x%26y%3Dz&zero=0', 'raw query');
});

check('path parameters are encoded once', async () => {
	const echoed = await make().echoGet({ p: 'a b/c?d' });
	equal(echoed.query.p, 'a b/c?d', 'decoded by the server');
});

check('request headers: defaults, per call, functions', async () => {
	const api = make({ requestHeaders: { 'X-Default': 'd', 'X-Fn': () => 'computed' } });
	const echoed = await api.echo({ body: {} }, { headers: { 'X-Call': 'c' } });
	equal([echoed.headers['x-default'], echoed.headers['x-fn'], echoed.headers['x-call']], ['d', 'computed', 'c']);
});

check('DELETE without a body sends none; with a body: sent on iOS, dropped by Android\'s HTTP client', async () => {
	const api = make({ logger: () => {} });
	const bare = await api.echoDelete();
	equal(bare.text || '', '', 'no body');
	const withBody = await api.echoDelete({ body: { reason: 'x' } });
	if (OS_ANDROID) {
		// A limit of Titanium's Android HTTP client, not of RESTe: this check records it so a change is noticed.
		equal(withBody.json, null, 'Android now sends DELETE bodies: the warning in RESTe can go');
		return 'Android dropped the DELETE body (platform limit)';
	}
	equal(withBody.json, { reason: 'x' }, 'body');
	return 'the DELETE body arrived';
});

check('form-encoded body', async () => {
	const echoed = await make().echoForm({ body: { user: 'a b', remember: true } });
	assert(/^application\/x-www-form-urlencoded/.test(echoed.headers['content-type']), 'content type was ' + echoed.headers['content-type']);
	// Flat values reach the HTTP client as given (as in 1.x), so the platform decides how a boolean is written.
	assert(/user=a(\+|%20)b/.test(echoed.text) && /remember=(true|1)/.test(echoed.text), 'body was ' + echoed.text);
	return echoed.text;
});

check('204 resolves null', async () => {
	equal(await make().empty(), null);
});

check('HTTP error: status, parsed body, headers, Retry-After', async () => {
	const api = make();
	await api.reset();
	const invalid = await rejection(api.invalid({ body: {} }));
	equal([invalid.kind, invalid.status, invalid.body.code], ['http', 422, 'VALIDATION_FAILED']);
	equal(invalid.body.errors, { name: ['The name is required.'] }, 'error body');
	const limited = await rejection(api.limited({ query: { after: 5, retry_after: 7 } }));
	equal([limited.status, limited.retryAfter, limited.headers['retry-after']], [429, 7000, '7']);
});

check('response headers: header(), headers, etag', async () => {
	const api = make();
	const response = await api.catalog({}, { fullResponse: true, cache: 'no-store' });
	assert(response.header('ETag') && response.header('etag') === response.header('ETag'), 'header() any case');
	equal(response.headers.etag, response.etag, 'headers map');
	assert(/json/.test(response.headers['content-type']), 'content-type in headers');
	return response.etag;
});

check('truncated JSON is a parse error', async () => {
	const error = await rejection(make().brokenJson());
	equal(error.kind, 'parse');
});

check('a timeout is reported as a timeout', async () => {
	const started = Date.now();
	const error = await rejection(make().slow({ query: { ms: 4000 } }, { timeout: 700 }));
	equal(error.kind, 'timeout', 'kind (platform said: ' + JSON.stringify(error.cause && error.cause.error) + ', code ' + (error.cause && error.cause.code) + ')');
	return 'after ' + (Date.now() - started) + 'ms; platform message: ' + JSON.stringify(error.cause && error.cause.error) + ' code ' + (error.cause && error.cause.code);
});

check('a dropped connection is a network error', async () => {
	const error = await rejection(make().drop());
	equal(error.kind, 'network', 'kind (platform said: ' + JSON.stringify(error.cause && error.cause.error) + ')');
	equal(error.status, 0, 'status');
	return 'platform message: ' + JSON.stringify(error.cause && error.cause.error) + ' code ' + (error.cause && error.cause.code);
});

check('abort() mid-flight cancels and calls nobody back', async () => {
	const api = make();
	const called = [];
	const handle = api.slow({ query: { ms: 1500 } }, () => called.push('load'), () => called.push('error'));
	await wait(200);
	handle.abort();
	const error = await rejection(handle);
	equal(error.kind, 'cancelled');
	await wait(1600);
	equal(called, [], 'callbacks after abort');
});

check('an abort signal cancels every request given it', async () => {
	const api = make();
	const controller = api.createAbortController();
	const a = api.slow({ query: { ms: 1500 } }, { signal: controller.signal, dedupe: false });
	const b = api.slow({ query: { ms: 1600 } }, { signal: controller.signal, dedupe: false });
	await wait(100);
	controller.abort();
	equal([(await rejection(a)).kind, (await rejection(b)).kind], ['cancelled', 'cancelled']);
});

check('retries a flaky GET through 503 and through dropped connections', async () => {
	const api = make({ retry: { retries: 3, baseDelay: 50, jitter: 0 } });
	await api.reset();
	const first = await api.flaky({ query: { key: 'device-503', fail: 2 } }, { fullResponse: true });
	equal([first.data.attempts, first.attempts], [3, 3], '503');
	const second = await api.flaky({ query: { key: 'device-drop', fail: 2, mode: 'drop' } });
	equal(second.attempts, 3, 'dropped');
});

check('a POST is not retried on its own', async () => {
	const api = make({ retry: { retries: 3, baseDelay: 20, jitter: 0 } });
	await api.reset();
	await rejection(api.request({ post: 'flaky' }, { query: { key: 'device-post', fail: 5 } }));
	const stats = await api.stats();
	equal(stats.hits['POST /flaky'], 1, 'sends');
});

check('idempotency: a lost response is replayed, the order exists once', async () => {
	const api = make({ retry: { retries: 2, baseDelay: 50, jitter: 0 } });
	await api.reset();
	const handle = api.order({ body: { item: 'coffee' }, query: { lose: 'first' } }, { fullResponse: true });
	const response = await handle;
	equal(response.header('Idempotent-Replayed'), 'true', 'replayed');
	equal(response.data.key, handle.idempotencyKey, 'key');
	equal((await api.stats()).ordersCreated, 1, 'orders created');
	return 'key ' + handle.idempotencyKey;
});

check('ETag: a 304 is a cache hit, a new version replaces it', async () => {
	const api = make();
	await api.reset();
	const first = await api.catalog({}, { fullResponse: true });
	const second = await api.catalog({}, { fullResponse: true });
	equal([first.fromCache, second.fromCache, second.notModified, second.status], [false, true, true, 200]);
	assert(second.data === first.data, 'the same parsed object');
	const stats = await api.stats();
	equal(stats.hits['GET /catalog'], 2, 'the server was asked twice');
	await api.bumpCatalog();
	const third = await api.catalog({}, { fullResponse: true });
	equal([third.notModified, third.body.version], [false, 2]);
	// What went over the wire: the server sent a 304; iOS hands the app the stored 200 instead.
	return 'server sent ' + stats.notModified + ' x 304; the HTTP client reported status ' + (second.http ? second.http.status : '?');
});

check('Cache-Control max-age: the second call does not reach the server', async () => {
	const api = make();
	await api.reset();
	const first = await api.settings();
	const second = await api.settings();
	assert(first === second, 'same object');
	equal((await api.stats()).hits['GET /settings'], 1, 'server hits');
});

check('persistent cache: a file store survives a new instance', async () => {
	const store = Reste.fileStore('reste-example-cache');
	const first = make({ cache: { store } });
	await first.reset();
	first.cache.clear();
	const fresh = await first.catalogPersisted({}, { fullResponse: true });
	equal(fresh.fromCache, false, 'first is from the network');
	const second = make({ cache: { store } }); // as after an app restart
	const cached = await second.catalogPersisted({}, { fullResponse: true });
	equal([cached.notModified, JSON.stringify(cached.data)], [true, JSON.stringify(fresh.data)], 'second instance');
	second.cache.clear();
});

check('persistent cache: the properties store round-trips', async () => {
	const store = Reste.propertiesStore();
	store.setItem('reste_example_probe', '{"a":1}');
	equal(store.getItem('reste_example_probe'), '{"a":1}');
	assert(store.keys().indexOf('reste_example_probe') !== -1, 'listed');
	store.removeItem('reste_example_probe');
	equal(store.getItem('reste_example_probe'), null);
});

check('401: the hook fires once for a burst and a token refresh retries every request', async () => {
	let token = 'wrong';
	let fired = 0;
	const api = make({
		dedupe: false,
		requestHeaders: { Authorization: () => 'Bearer ' + token },
		onStatus: {
			401() {
				fired++;
				return api.rotate().then((fresh) => {
					token = fresh.token;
					return 'retry';
				});
			}
		}
	});
	await api.reset();
	const results = await Promise.all([api.secure(), api.secure(), api.secure()]);
	equal(results, [{ secret: 42 }, { secret: 42 }, { secret: 42 }], 'results');
	equal(fired, 1, 'hook firings');
	equal((await api.stats()).refreshes, 1, 'token refreshes');
});

check('426 reaches its hook with the parsed body', async () => {
	const seen = [];
	const api = make({ onStatus: { 426: error => seen.push(error.body.code) } });
	equal((await rejection(api.upgrade())).status, 426);
	equal(seen, ['APP_UPDATE_REQUIRED']);
});

check('pagination: pages to the end with the server\'s metadata', async () => {
	const pager = make().paginate('getItems', { perPage: 20 });
	const sizes = [];
	while (pager.hasMore) {
		sizes.push((await pager.next()).items.length);
	}
	equal([sizes, pager.total, pager.lastPage, pager.items.length], [[20, 20, 5], 45, 3, 45]);
});

check('pagination: before/after cursors and an opaque token', async () => {
	const api = make();
	await api.reset();
	const messages = api.paginate('getMessages');
	await messages.next();
	await messages.next();
	equal([messages.items[0].id, messages.items.length, messages.hasMore], [61, 40, true], 'cursor ids');
	const feed = api.paginate('feed');
	let pages = 0;
	while (feed.hasMore) {
		await feed.next();
		pages++;
	}
	equal([pages, feed.items.length], [5, 45], 'token cursor');
});

check('multipart upload: a blob, a file and fields arrive intact', async () => {
	const api = make({ requestHeaders: { 'Content-Type': 'application/json' } });
	const blob = blobOf(300 * 1024, 67);
	const file = Ti.Filesystem.getFile(Ti.Filesystem.applicationCacheDirectory, 'reste-check-upload.txt');
	file.write('contents of a real file');
	const result = await api.upload({ body: { photo: blob, 'documents[]': [file], caption: 'Front door ✓', tags: ['a', 'b'], meta: { private: true } } });
	equal(result.fields, { caption: 'Front door ✓', 'tags[0]': 'a', 'tags[1]': 'b', 'meta[private]': 'true' }, 'fields');
	equal(result.files.photo.size, 300 * 1024, 'blob size');
	equal(result.files.photo.sha1, Ti.Utils.sha1(blob), 'blob sha1');
	equal(result.files['documents[0]'].size, 23, 'file size');
	file.deleteFile();
	return 'photo type ' + result.files.photo.type + ', file name ' + result.files['documents[0]'].filename;
});

check('upload progress is reported and rises', async () => {
	const progress = [];
	await make().upload({ body: { file: blobOf(3 * 1024 * 1024) } }, { onProgress: value => progress.push(value) });
	assert(progress.length > 0, 'no progress events');
	assert(progress.every((value, index) => value >= 0 && value <= 1 && (index === 0 || value >= progress[index - 1])), 'not monotonic: ' + progress.join(','));
	return progress.length + ' events, last ' + progress[progress.length - 1];
});

check('an upload can be cancelled', async () => {
	const api = make();
	const handle = api.upload({ body: { file: blobOf(8 * 1024 * 1024) } }, { timeout: 60000 });
	await wait(5);
	handle.abort();
	equal((await rejection(handle)).kind, 'cancelled');
});

check('an upload goes through the error pipeline and carries an idempotency key', async () => {
	const api = make({ requestHeaders: { 'X-Token': 'wrong' }, mapError: error => ({ mapped: error.status, code: error.body && error.body.code }) });
	equal(await rejection(api.upload({ body: { f: blobOf(10) } })), { mapped: 401, code: 'UNAUTHENTICATED' }, 'mapped error');
	const ok = make();
	const result = await ok.upload({ body: { f: blobOf(10) } }, { idempotencyKey: 'device-key-1' });
	equal(result.idempotencyKey, 'device-key-1', 'key header');
});

check('download to a file with progress', async () => {
	const file = Ti.Filesystem.getFile(Ti.Filesystem.applicationCacheDirectory, 'reste-check-download.bin');
	if (file.exists()) {
		file.deleteFile();
	}
	const progress = [];
	const response = await make().download({ size: 300000 }, { file, onProgress: value => progress.push(value), fullResponse: true });
	equal(response.status, 200);
	equal(file.size, 300000, 'file size');
	assert(progress.length > 0, 'no progress events');
	file.deleteFile();
	return progress.length + ' progress events';
});

check('de-duplication: two identical GETs in flight are one request', async () => {
	const api = make();
	await api.reset();
	const [a, b] = await Promise.all([api.slow({ query: { ms: 300 } }), api.slow({ query: { ms: 300 } })]);
	assert(a === b, 'same result object');
	equal((await api.stats()).hits['GET /slow'], 1, 'server hits');
});

check('interceptors: request (async), response and error', async () => {
	const api = make({
		interceptors: {
			request: request => wait(10).then(() => {
				request.headers['X-Stamp'] = 'late';
			}),
			response(response) {
				if (response.endpoint === 'echo') {
					response.data = { stamp: response.data.headers['x-stamp'] };
				}
			},
			error: error => (error.status === 426 ? { resolve: 'recovered' } : undefined)
		}
	});
	equal(await api.echo({ body: {} }), { stamp: 'late' }, 'request and response');
	equal(await api.upgrade(), 'recovered', 'error');
});

check('the debug logger prints no credentials', async () => {
	const lines = [];
	const api = make({
		debug: 'verbose',
		logger: (level, message, details) => lines.push(message + ' ' + JSON.stringify(details || '')),
		requestHeaders: { Authorization: 'Bearer DEVICE-SECRET', 'X-Access-Token': 'DEVICE-SECRET' }
	});
	await api.echo({ body: { password: 'DEVICE-SECRET', refreshToken: 'DEVICE-SECRET', email: 'a@b.c' }, query: { access_token: 'DEVICE-SECRET', 'X-Amz-Signature': 'DEVICE-SECRET' } });
	await api.request({ get: 'echo?p=<token>' }, { token: 'DEVICE-SECRET' });
	const output = lines.join('\n');
	assert(output.indexOf('DEVICE-SECRET') === -1, 'a credential was logged');
	assert(output.indexOf('[redacted]') !== -1 && output.indexOf('a@b.c') !== -1, 'expected redacted output');
});

check('default headers are not sent to another origin', async () => {
	const api = make({ requestHeaders: { Authorization: 'Bearer DEVICE-TOKEN' } });
	const other = SERVER.replace('127.0.0.1', 'localhost'); // the same server under another origin
	const outside = await api.request({ method: 'POST', url: other + 'echo', unwrap: false }, { body: {} });
	equal(outside.headers.authorization, undefined, 'token sent to another origin');
	const inside = await api.echo({ body: {} });
	equal(inside.headers.authorization, 'Bearer DEVICE-TOKEN', 'token on the API\'s own origin');
});

check('a header function that throws rejects the call', async () => {
	const api = make({ requestHeaders: { Authorization: () => { throw new Error('no token yet'); } } });
	let handle;
	try {
		handle = api.health();
	} catch (error) {
		throw new Error('the call threw: ' + error.message);
	}
	const error = await rejection(handle);
	assert(/no token yet/.test(error.message), 'rejected with: ' + error.message);
});

check('a model made with { id } updates instead of creating', async () => {
	const made = withModels();
	try {
		await made.api.reset();
		const model = made.createThing({ id: 2, name: 'Second' });
		equal(model.isNew(), false, 'isNew');
		await model.save({ name: 'Second, renamed' });
		equal((await made.api.getThing({ id: 2 })).name, 'Second, renamed', 'on the server');
		equal((await made.api.getThings()).length, 3, 'no duplicate was created');
	} finally {
		made.cleanup();
	}
});

check('upstream callbacks: onLoad, onError with retry, beforeSend, config.onLoad', async () => {
	const api = make({
		beforeSend: (body, next) => next(Object.assign({ stamped: true }, body)),
		onLoad: (body, next) => next(body)
	});
	const echoed = await new Promise((resolve, reject) => api.echo({ body: { a: 1 } }, resolve, reject));
	equal(echoed.json, { stamped: true, a: 1 }, 'beforeSend');
	const failure = await new Promise(resolve => api.invalid({ body: {} }, () => resolve(null), (error, retry) => resolve({ error, retry })));
	equal([failure.error.code, failure.error.content.code, typeof failure.retry], [422, 'VALIDATION_FAILED', 'function'], 'onError');
});

check('collections: scoped sync fills them and Backbone.sync is untouched', async () => {
	const original = Backbone.sync;
	const made = withModels();
	try {
		await made.api.reset();
		const events = [];
		made.things.on('all', name => events.push(name));
		await made.things.fetch({ merge: false });
		equal(made.things.pluck('name'), ['First', 'Second', 'Third'], 'names');
		assert(Backbone.sync === original, 'Backbone.sync was replaced');
		equal(events.filter(name => name === 'sync').length, 1, 'sync events');
		return 'Backbone ' + Backbone.VERSION;
	} finally {
		made.cleanup();
	}
});

check('collections: a merge keeps the instances and renders a bound list once', async () => {
	const made = withModels();
	try {
		await made.api.reset();
		await made.things.fetch();
		const before = made.things.models.slice();
		let renders = 0;
		made.things.on(bindingEvents(), () => renders++);
		await made.api.patchThing({ id: 2, body: { name: 'Renamed on the server' } });
		await made.api.createThing({ body: { name: 'Fourth' } });
		const result = await made.things.fetch();
		assert(before.every((model, index) => made.things.at(index) === model), 'instances changed');
		equal([result.added.length, result.changed.length, result.removed.length, renders], [1, 1, 0, 1], 'added, changed, removed, renders');
		equal(made.things.get(2).get('name'), 'Renamed on the server');
	} finally {
		made.cleanup();
	}
});

check('collections: an unchanged refresh parses and renders nothing', async () => {
	const made = withModels();
	try {
		await made.api.reset();
		await made.things.fetch();
		let events = 0;
		made.things.on(bindingEvents(), () => events++);
		const result = await made.things.fetch();
		equal([result.unchanged, events], [true, 0]);
	} finally {
		made.cleanup();
	}
});

check('collections: fetchNext() pages, refresh() returns to the first page', async () => {
	const made = withModels();
	try {
		await made.items.fetch();
		equal([made.items.length, made.items.paging.total, made.items.hasMore()], [15, 45, true], 'first page');
		while (made.items.hasMore()) {
			await made.items.fetchNext();
		}
		equal(made.items.length, 45, 'all pages');
		await made.items.refresh();
		equal([made.items.length, made.items.paging.page], [15, 1], 'after refresh');
	} finally {
		made.cleanup();
	}
});

check('models: create, update, patch, delete, fetch', async () => {
	const made = withModels();
	try {
		await made.api.reset();
		await made.things.fetch();
		const created = made.things.create({ name: 'Made on a device', count: 1 }, { wait: true });
		await wait(800);
		assert(created.id >= 4, 'no id from the server: ' + created.id);
		await created.save({ name: 'Renamed', count: 2 });
		await created.save({ count: 3 }, { patch: true });
		const loaded = made.createThing({ id: created.id });
		assert(loaded === created, 'identity: one model per id');
		await loaded.fetch();
		equal([loaded.get('name'), loaded.get('count')], ['Renamed', 3], 'after update and patch');
		await created.destroy({ wait: true });
		equal((await rejection(made.api.getThing({ id: created.id }))).status, 404, 'deleted');
	} finally {
		made.cleanup();
	}
});

check('optimistic save rolls back when the server refuses', async () => {
	const made = withModels();
	try {
		await made.api.reset();
		await made.things.fetch();
		const first = made.things.get(1);
		const saving = first.save({ name: 'Refused' }, { optimistic: true, patch: true, query: { fail: 409 } });
		equal(first.get('name'), 'Refused', 'shown at once');
		equal((await rejection(saving)).status, 409);
		equal(first.get('name'), 'First', 'rolled back');
	} finally {
		made.cleanup();
	}
});

check('identity: two collections share one model per id', async () => {
	const made = withModels();
	try {
		await made.api.reset();
		await made.things.fetch();
		await made.mine.fetch();
		assert(made.things.get(1) === made.mine.get(1), 'different instances');
		made.things.upsert({ id: 1, name: 'Changed once' });
		equal(made.mine.get(1).get('name'), 'Changed once');
	} finally {
		made.cleanup();
	}
});

check('a list follows its collection', async () => {
	const made = withModels();
	try {
		await made.api.reset();
		const list = made.api.list({ collection: made.things, filter: model => model.get('count') < 10, place: 'end' });
		let changes = 0;
		list.on('change', () => changes++);
		await list.load();
		equal(list.models().map(model => model.id), [1, 2, 3], 'the page');
		made.things.upsert({ id: 50, name: 'From a socket', count: 0 });
		made.things.upsert({ id: 51, name: 'Does not belong', count: 99 });
		made.things.get(1).set({ count: 99 });
		await wait(20);
		equal(list.models().map(model => model.id), [2, 3, 50], 'after a join and a drop-out');
		assert(changes >= 2, 'change events: ' + changes);
		list.destroy();
	} finally {
		made.cleanup();
	}
});

check('session reset drops a response that arrives late', async () => {
	const made = withModels();
	try {
		await made.api.reset();
		const loading = made.things.fetch({ query: {} });
		made.api.session.reset({ abort: false });
		equal((await rejection(loading)).kind, 'stale');
		equal(made.things.length, 0, 'nothing was written');
	} finally {
		made.cleanup();
	}
});

// ---------------------------------------------------------------- measurements on this device

async function benchmarks(log) {
	const report = (name, value) => log('RESTE-BENCH ' + name + ' ' + value);
	const median = samples => samples.slice().sort((a, b) => a - b)[Math.floor(samples.length / 2)];

	// Defining endpoints.
	const methods = [];
	for (let i = 0; i < 500; i++) {
		methods.push({ name: 'bench' + i, get: 'resource' + i + '/<id>' });
	}
	const defining = [];
	for (let run = 0; run < 7; run++) {
		const started = Date.now();
		const api = new Reste();
		api.config({ url: SERVER, methods });
		defining.push(Date.now() - started);
	}
	report('config-500-endpoints-ms', median(defining));

	// A 500-item list over the network: request + parse, then into a collection.
	const made = withModels({ retry: false }, { skipUnchanged: true });
	try {
		const fetches = [];
		for (let run = 0; run < 5; run++) {
			const started = Date.now();
			await made.api.big({ query: { count: 500 } }, { dedupe: false });
			fetches.push(Date.now() - started);
		}
		report('get-500-items-ms', median(fetches));

		let renders = 0;
		made.big.on(bindingEvents(), () => renders++);
		let started = Date.now();
		await made.big.fetch({ query: { count: 500 } });
		report('collection-first-fetch-500-ms', Date.now() - started);
		report('collection-first-fetch-500-renders', renders);

		renders = 0;
		started = Date.now();
		const same = await made.big.fetch({ query: { count: 500 } });
		report('collection-refetch-unchanged-ms', Date.now() - started);
		report('collection-refetch-unchanged-renders', renders + (same.unchanged ? ' (not parsed)' : ''));

		renders = 0;
		started = Date.now();
		const edited = await made.big.fetch({ query: { count: 500, changed: 10 } });
		report('collection-refetch-10-changed-ms', Date.now() - started);
		report('collection-refetch-10-changed-renders', renders + ' (' + edited.changed.length + ' models changed)');

		// The longest stretch the JS thread is busy while 2000 items arrive, whole and in chunks.
		for (const chunk of [0, 100]) {
			made.big.reset([]);
			let longest = 0;
			let last = Date.now();
			const ticker = setInterval(() => {
				const now = Date.now();
				longest = Math.max(longest, now - last);
				last = now;
			}, 1);
			started = Date.now();
			await made.big.fetch({ query: { count: 2000, rev: chunk }, chunk });
			const now = Date.now();
			longest = Math.max(longest, now - last);
			clearInterval(ticker);
			report('merge-2000-chunk-' + chunk + '-longest-block-ms', longest);
			report('merge-2000-chunk-' + chunk + '-total-ms', now - started);
		}
	} finally {
		made.cleanup();
	}
}

/** Checks the table bound to Alloy.Collections.things in the example's first tab. */
async function bindingCheck(context) {
	const api = Alloy.Globals.api;
	const things = Alloy.Collections.things;
	await api.request({ post: '_reset', session: false });
	const rows = () => {
		const sections = context.table.sections || [];
		return sections.length ? sections[0].rowCount : 0;
	};
	await things.fetch({ reset: true });
	await wait(300);
	equal(rows(), 3, 'rows after the first fetch');
	const before = context.renders();
	await api.createThing({ body: { name: 'Bound row' } });
	await api.patchThing({ id: 1, body: { name: 'Bound rename' } });
	await things.fetch();
	await wait(300);
	equal(rows(), 4, 'rows after a merge');
	equal(context.renders() - before, 4, 'rows transformed: one render of four rows');
	const again = context.renders();
	await things.fetch();
	await wait(300);
	equal(context.renders() - again, 0, 'an unchanged refresh rendered nothing');
	return rows() + ' rows in the TableView';
}

/**
 * Runs every check. context: { table, renders(), onLine(line) }.
 * @returns {Promise<{pass: number, fail: number}>}
 */
async function run(context) {
	const log = (line) => {
		Ti.API.info(line);
		if (context && context.onLine) {
			context.onLine(line.replace(/^RESTE-(CHECK|BENCH) /, ''));
		}
	};
	const summary = { pass: 0, fail: 0 };
	const all = CHECKS.slice();
	if (context && context.table) {
		all.push({ name: 'Alloy data binding: a TableView follows the collection', run: () => bindingCheck(context) });
	}
	log('RESTE-CHECK START server=' + SERVER + ' platform=' + Ti.Platform.osname + ' sdk=' + Ti.version + ' backbone=' + Backbone.VERSION + ' reste=' + Reste.version);
	try {
		await make().health();
	} catch (error) {
		log('RESTE-CHECK FAIL cannot reach the test server at ' + SERVER + ': ' + error.message + ' (npm run server; adb reverse tcp:8787 tcp:8787)');
		summary.fail++;
		log('RESTE-CHECK DONE pass=0 fail=1 platform=' + Ti.Platform.osname + ' sdk=' + Ti.version);
		return summary;
	}
	for (const item of all) {
		try {
			const detail = await item.run();
			summary.pass++;
			log('RESTE-CHECK PASS ' + item.name + (detail ? ' [' + detail + ']' : ''));
		} catch (error) {
			summary.fail++;
			log('RESTE-CHECK FAIL ' + item.name + ': ' + (error && error.message ? error.message : JSON.stringify(error)));
		}
	}
	try {
		await benchmarks(log);
	} catch (error) {
		log('RESTE-CHECK FAIL benchmarks: ' + (error && error.message ? error.message : error));
		summary.fail++;
	}
	log('RESTE-CHECK DONE pass=' + summary.pass + ' fail=' + summary.fail + ' platform=' + Ti.Platform.osname + ' sdk=' + Ti.version);
	return summary;
}

module.exports = { run };
