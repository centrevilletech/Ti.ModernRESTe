'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rejection, wait } = require('../helpers/setup');

const METHODS = [
	{ name: 'getVideos', get: 'videos' },
	{ name: 'getVideo', get: 'videos/<id>' },
	{ name: 'addVideo', post: 'videos' },
	{ name: 'putVideo', put: 'videos/<id>' },
	{ name: 'patchVideo', patch: 'videos/<id>' },
	{ name: 'deleteVideo', delete: 'videos/<id>' },
	{ name: 'headVideo', head: 'videos/<id>' }
];

let ti;
afterEach(() => ti && ti.uninstall());

function make(config) {
	const made = setup(Object.assign({ methods: METHODS }, config));
	ti = made.ti;
	ti.respond(request => ({ status: 200, body: { method: request.method, url: request.url } }));
	return made;
}

describe('requests', () => {
	it('resolves a promise with the parsed body', async () => {
		const { api } = make();
		assert.deepEqual(await api.getVideos(), { method: 'GET', url: 'https://api.test/v1/videos' });
	});

	it('maps each verb key to its HTTP method', async () => {
		const { api } = make();
		await api.getVideo({ id: 1 });
		await api.addVideo({ body: {} });
		await api.putVideo({ id: 1, body: {} });
		await api.patchVideo({ id: 1, body: {} });
		await api.deleteVideo({ id: 1 });
		await api.headVideo({ id: 1 });
		assert.deepEqual(ti.requests.map(request => request.method), ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);
	});

	it('accepts { method, url } definitions', async () => {
		const { api } = make({ methods: [{ name: 'opts', method: 'options', url: 'videos' }] });
		await api.opts();
		assert.equal(ti.last.method, 'OPTIONS');
		assert.equal(ti.last.url, 'https://api.test/v1/videos');
	});

	it('sends JSON bodies with POST, PUT, PATCH and DELETE and sets the content type', async () => {
		const { api } = make();
		await api.addVideo({ body: { a: 1 } });
		await api.putVideo({ id: 1, body: { a: 2 } });
		await api.patchVideo({ id: 1, body: { a: 3 } });
		await api.deleteVideo({ id: 1, body: { a: 4 } });
		assert.deepEqual(ti.requests.map(request => request.json), [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }]);
		ti.requests.forEach(request => assert.equal(request.headers['Content-Type'], 'application/json'));
	});

	it('sends no body with GET, HEAD, or a DELETE that has none', async () => {
		const { api } = make();
		await api.getVideo({ id: 1, body: { ignored: true } });
		await api.deleteVideo({ id: 1 });
		assert.equal(ti.requests[0].body, undefined);
		assert.equal(ti.requests[1].body, undefined);
		assert.equal(ti.requests[1].headers['Content-Type'], undefined);
	});

	it('keeps upstream\'s empty JSON object for a POST without a body', async () => {
		const { api } = make();
		await api.addVideo();
		assert.equal(ti.last.body, '{}');
	});

	it('sends a string body as it is', async () => {
		const { api } = make();
		await api.addVideo({ body: '<xml/>' }, { headers: { 'Content-Type': 'application/xml' } });
		assert.equal(ti.last.body, '<xml/>');
		assert.equal(ti.last.headers['Content-Type'], 'application/xml');
	});

	it('form-encodes when the content type says so, or the method is marked form', async () => {
		const { api } = make({ methods: [{ name: 'login', post: 'login', form: true }, { name: 'legacy', post: 'legacy', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }] });
		await api.login({ body: { user: 'a', remember: true } });
		assert.deepEqual(ti.last.body, { user: 'a', remember: true }); // flat values reach the HTTP client as given, as in 1.x
		assert.equal(ti.last.headers['Content-Type'], 'application/x-www-form-urlencoded');
		await api.legacy({ body: { user: 'b' } });
		assert.deepEqual(ti.last.body, { user: 'b' });
	});

	it('builds query strings from params.query, the method\'s defaults and options.query', async () => {
		const { api } = make({ methods: [{ name: 'list', get: 'jobs', query: { per_page: 20, sort: 'new' } }] });
		await api.list({ query: { status: 'open', tags: ['a', 'b'], empty: null } }, { query: { sort: 'old' } });
		assert.equal(decodeURIComponent(ti.last.url), 'https://api.test/v1/jobs?per_page=20&sort=old&status=open&tags[]=a&tags[]=b');
	});

	it('honours config.query settings and a custom serializer', async () => {
		let made = make({ query: { arrayFormat: 'repeat' }, methods: [{ name: 'list', get: 'jobs' }] });
		await made.api.list({ query: { t: [1, 2] } });
		assert.equal(ti.last.url, 'https://api.test/v1/jobs?t=1&t=2');
		ti.uninstall();
		made = make({ querySerializer: query => 'custom=' + Object.keys(query).length, methods: [{ name: 'list', get: 'jobs' }] });
		await made.api.list({ query: { a: 1, b: 2 } });
		assert.equal(ti.last.url, 'https://api.test/v1/jobs?custom=2');
	});

	it('treats params.query as a path value when the URL has a <query> placeholder', async () => {
		const { api } = make({ methods: [{ name: 'search', get: 'search?q=<query>' }] });
		await api.search({ query: 'two words' });
		assert.equal(ti.last.url, 'https://api.test/v1/search?q=two%20words');
	});

	it('an empty string is a missing value in the path, and a value in the query string', async () => {
		const { api } = make({ methods: [{ name: 'find', get: 'things/<id>?name=<name>&where={"x": "<x>"}' }] });
		const error = await rejection(api.find({ id: '', name: 'n', x: 'y' }));
		assert.deepEqual([error.kind, error.missing], ['params', ['id']]);
		await api.find({ id: 7, name: '', x: '' });
		assert.equal(ti.last.url, 'https://api.test/v1/things/7?name=&where={"x": ""}');
		assert.equal((await rejection(api.find({ id: 7, name: null, x: '' }))).kind, 'params');
	});

	it('rejects, and never throws, when a path parameter is missing', async () => {
		const { api } = make();
		let handle;
		assert.doesNotThrow(() => {
			handle = api.getVideo({});
		});
		const error = await rejection(handle);
		assert.equal(error.kind, 'params');
		assert.equal(error.endpoint, 'getVideo');
		assert.deepEqual(error.missing, ['id']);
		assert.equal(ti.requests.length, 0);
	});

	it('can leave path values unencoded per method or globally', async () => {
		let made = make({ methods: [{ name: 'file', get: 'files/<path>', encodeParams: false }] });
		await made.api.file({ path: 'a/b' });
		assert.equal(ti.last.url, 'https://api.test/v1/files/a/b');
		ti.uninstall();
		made = make({ encodeParams: false, methods: [{ name: 'file', get: 'files/<path>' }] });
		await made.api.file({ path: 'a/b' });
		assert.equal(ti.last.url, 'https://api.test/v1/files/a/b');
	});

	it('uses the timeout of the call, then the method, then the config, then 10 s', async () => {
		const { api } = make({ timeout: 4000, methods: [{ name: 'slow', get: 'slow', timeout: 30000 }, { name: 'plain', get: 'plain' }] });
		await api.slow();
		await api.plain();
		await api.plain({}, { timeout: 1234 });
		assert.deepEqual(ti.clients.map(client => client.creation.timeout), [30000, 4000, 1234]);
		ti.uninstall();
		const bare = make({});
		await bare.api.getVideos();
		assert.equal(ti.clients[0].creation.timeout, 10000);
	});

	it('does not send to the base URL when a method has an absolute URL', async () => {
		const { api } = make({ methods: [{ name: 'push', post: 'https://push.example/send' }, { name: 'odd', get: 'httpstatus/200' }] });
		await api.push({ body: {} });
		assert.equal(ti.last.url, 'https://push.example/send');
		await api.odd();
		assert.equal(ti.last.url, 'https://api.test/v1/httpstatus/200');
	});

	it('evaluates a function URL on every call', async () => {
		let host = 'a';
		const { api } = make({ methods: [{ name: 'dyn', get: () => 'https://' + host + '.example/x/<id>' }] });
		await api.dyn({ id: 1 });
		host = 'b';
		await api.dyn({ id: 2 });
		assert.deepEqual(ti.requests.map(request => request.url), ['https://a.example/x/1', 'https://b.example/x/2']);
	});

	it('follows setUrl() for later calls', async () => {
		const { api } = make();
		api.setUrl('https://staging.test/');
		await api.getVideos();
		assert.equal(ti.last.url, 'https://staging.test/videos');
		assert.equal(api.getUrl(), 'https://staging.test/');
	});

	it('request() calls a method by name or sends a one-off definition', async () => {
		const { api } = make();
		await api.request('getVideo', { id: 5 });
		assert.equal(ti.last.url, 'https://api.test/v1/videos/5');
		await api.request({ method: 'POST', url: 'things/<id>' }, { id: 2, body: { a: 1 } });
		assert.equal(ti.last.method, 'POST');
		assert.equal(ti.last.url, 'https://api.test/v1/things/2');
		const error = await rejection(api.request('nope'));
		assert.equal(error.kind, 'config');
	});

	it('resolves the full response when asked', async () => {
		const { api } = make();
		ti.respond(() => ({ status: 201, body: { id: 1 }, headers: { ETag: '"v1"', 'X-Total': '9' } }));
		const response = await api.addVideo({ body: {} }, { fullResponse: true });
		assert.equal(response.status, 201);
		assert.deepEqual(response.data, { id: 1 });
		assert.deepEqual(response.body, { id: 1 });
		assert.equal(response.header('x-total'), '9');
		assert.equal(response.headers.etag, '"v1"');
		assert.equal(response.etag, '"v1"');
		assert.equal(response.endpoint, 'addVideo');
		assert.equal(response.attempts, 1);
		assert.equal(response.ok, true);
	});

	it('unwraps an envelope and keeps its metadata', async () => {
		const { api } = make({ unwrap: 'data', meta: 'meta', methods: [{ name: 'list', get: 'jobs' }, { name: 'raw', get: 'raw', unwrap: false }] });
		ti.respond(() => ({ status: 200, body: { data: [1, 2], meta: { total: 2 } } }));
		assert.deepEqual(await api.list(), [1, 2]);
		const response = await api.list({}, { fullResponse: true });
		assert.deepEqual(response.meta, { total: 2 });
		assert.deepEqual(response.body, { data: [1, 2], meta: { total: 2 } });
		assert.deepEqual(await api.raw(), { data: [1, 2], meta: { total: 2 } });
		ti.respond(() => ({ status: 200, body: { message: 'no envelope here' } }));
		assert.deepEqual(await api.list(), { message: 'no envelope here' });
	});

	it('gives null for an empty body and text for a body that is not JSON', async () => {
		const { api } = make();
		ti.respond(() => ({ status: 204 }));
		assert.equal(await api.getVideos(), null);
		ti.respond(() => ({ status: 200, text: 'plain words', headers: { 'Content-Type': 'text/plain' } }));
		assert.equal(await api.getVideos(), 'plain words');
	});

	it('can skip parsing with responseType text', async () => {
		const { api } = make({ methods: [{ name: 'raw', get: 'raw', responseType: 'text' }] });
		ti.respond(() => ({ status: 200, text: '{"a":1}', headers: { 'Content-Type': 'application/json' } }));
		assert.equal(await api.raw(), '{"a":1}');
	});

	it('parses the response text once', async () => {
		const { api } = make();
		const original = JSON.parse;
		let parses = 0;
		JSON.parse = function () {
			parses++;
			return original.apply(this, arguments);
		};
		try {
			ti.respond(() => ({ status: 200, text: '{"a":[1,2,3]}' }));
			await api.getVideos();
		} finally {
			JSON.parse = original;
		}
		assert.equal(parses, 1); // upstream parsed twice: once to test, once for the value
	});

	it('sends synchronously, so default headers changed right before a call apply to it', () => {
		const { api } = make();
		api.setRequestHeaders({ 'X-Step': 'one' });
		api.getVideos().catch(() => {});
		api.setRequestHeaders({ 'X-Step': 'two' });
		assert.equal(ti.requests.length, 1);
		assert.equal(ti.requests[0].headers['X-Step'], 'one');
	});
});

describe('headers', () => {
	it('layers default, method and call headers without sharing state between calls', async () => {
		const { api } = make({
			requestHeaders: { 'X-App': '1', Accept: 'application/json' },
			methods: [{ name: 'a', get: 'a', headers: { 'X-Method': 'm', accept: 'text/plain' } }, { name: 'b', get: 'b' }]
		});
		ti.respond(() => null); // keep both in flight
		const first = api.a({}, { headers: { Authorization: 'Bearer one', 'X-Call': '1' } });
		const second = api.b({}, { headers: { Authorization: 'Bearer two' } });
		assert.deepEqual(ti.requests[0].headers, { 'X-App': '1', accept: 'text/plain', 'X-Method': 'm', Authorization: 'Bearer one', 'X-Call': '1' });
		assert.deepEqual(ti.requests[1].headers, { 'X-App': '1', Accept: 'application/json', Authorization: 'Bearer two' });
		ti.requests.forEach(request => request.respond({ status: 200, body: {} }));
		await Promise.all([first, second]);
	});

	it('accepts requestHeaders as the upstream name for method headers', async () => {
		const { api } = make({ methods: [{ name: 'a', get: 'a', requestHeaders: { 'X-Old': 'yes' } }] });
		await api.a();
		assert.equal(ti.last.headers['X-Old'], 'yes');
	});

	it('calls function values once per request', async () => {
		let calls = 0;
		const { api } = make({ debug: false, requestHeaders: { Authorization: () => 'Bearer ' + (++calls) } });
		await api.getVideos();
		await api.getVideos();
		assert.deepEqual(ti.requests.map(request => request.headers.Authorization), ['Bearer 1', 'Bearer 2']);
	});

	it('removes a header when a later layer sets it to null', async () => {
		const { api } = make({ requestHeaders: { 'Content-Type': 'application/json', 'X-Keep': '1' } });
		await api.addVideo({ body: 'raw' }, { headers: { 'content-type': null } });
		assert.deepEqual(ti.last.headers, { 'X-Keep': '1' });
	});

	it('changeRequestHeader, removeRequestHeaderItem and getRequestHeaders manage the defaults', async () => {
		const { api } = make({ requestHeaders: { A: '1' } });
		api.changeRequestHeader({ A: '2', B: '3' }); // upstream only looked at the first key
		api.changeRequestHeader({ c: '4' });
		api.removeRequestHeaderItem('b');
		assert.deepEqual(api.getRequestHeaders(), { A: '2', c: '4' });
		await api.getVideos();
		assert.deepEqual(ti.last.headers, { A: '2', c: '4' });
	});

	it('default headers stay on the API\'s origin: a full URL elsewhere does not get the token', async () => {
		const { api } = make({
			requestHeaders: { Authorization: () => 'Bearer secret' },
			methods: [
				{ name: 'geo', get: 'https://maps.example/geocode', headers: { 'X-Key': 'k' } },
				{ name: 'upload', put: () => 'https://bucket.example/object?signature=abc' },
				{ name: 'sameOrigin', get: 'https://API.test/v2/other' },
				{ name: 'otherPort', get: 'https://api.test:8443/v1/x' },
				{ name: 'optedIn', get: 'https://partner.example/x', globalHeaders: true },
				{ name: 'optedOut', get: 'inside', globalHeaders: false },
				{ name: 'relative', get: 'inside' }
			]
		});
		await api.geo();
		assert.deepEqual(ti.last.headers, { 'X-Key': 'k' });
		await api.upload({ body: 'bytes' });
		assert.equal(ti.last.headers.Authorization, undefined);
		await api.otherPort();
		assert.equal(ti.last.headers.Authorization, undefined);
		await api.sameOrigin();
		assert.equal(ti.last.headers.Authorization, 'Bearer secret');
		await api.optedIn();
		assert.equal(ti.last.headers.Authorization, 'Bearer secret');
		await api.optedOut();
		assert.equal(ti.last.headers.Authorization, undefined);
		await api.relative();
		assert.equal(ti.last.headers.Authorization, 'Bearer secret');
	});

	it('default headers follow setUrl(): the origin is the one in use when the call is made', async () => {
		const { api } = make({ requestHeaders: { Authorization: 'Bearer secret' }, methods: [{ name: 'staging', get: 'https://staging.test/x' }] });
		await api.staging();
		assert.equal(ti.last.headers.Authorization, undefined);
		api.setUrl('https://staging.test/v1/');
		await api.staging();
		assert.equal(ti.last.headers.Authorization, 'Bearer secret');
	});
});

describe('configuration', () => {
	it('works without methods and without config()', async () => {
		const made = setup(false);
		ti = made.ti;
		ti.respond(() => ({ status: 200, body: { ok: true } }));
		made.api.addMethod({ name: 'ping', get: 'https://x.test/ping' });
		assert.deepEqual(await made.api.ping(), { ok: true });
		made.api.config({}); // upstream threw: config.methods was required
	});

	it('can be configured again', async () => {
		const { api } = make();
		api.config({ url: 'https://second.test/', methods: [{ name: 'getVideos', get: 'v2/videos' }] });
		await api.getVideos();
		assert.equal(ti.last.url, 'https://second.test/v2/videos');
		assert.equal(api.getVideo, undefined);
	});

	it('refuses a second method with the same name and names that belong to RESTe', () => {
		const { api } = make();
		assert.throws(() => api.addMethod({ name: 'getVideos', get: 'x' }), /already defined/);
		assert.throws(() => api.addMethod({ name: 'config', get: 'x' }), /already defined/);
		assert.throws(() => api.addMethod({ name: 'setUrl', get: 'x' }), /already defined/);
	});

	it('lets a method take the name of an addition made in 2.0', async () => {
		const { api } = make({ methods: [{ name: 'session', post: 'session' }, { name: 'cache', get: 'cache' }] });
		await api.session({ body: { user: 'a' } });
		assert.equal(ti.last.url, 'https://api.test/v1/session');
		await api.cache();
		assert.equal(ti.last.url, 'https://api.test/v1/cache');
	});

	it('removeMethod and hasMethod', () => {
		const { api } = make();
		assert.equal(api.hasMethod('getVideos'), true);
		api.removeMethod('getVideos');
		assert.equal(api.hasMethod('getVideos'), false);
		assert.equal(api.getVideos, undefined);
	});

	it('works without `new`', () => {
		const made = setup(false);
		ti = made.ti;
		const instance = made.Reste();
		assert.equal(typeof instance.config, 'function');
		assert.ok(instance instanceof made.Reste);
	});

	it('keeps instances apart', async () => {
		const made = make({ requestHeaders: { 'X-One': '1' } });
		const other = new made.Reste();
		other.config({ url: 'https://other.test/', requestHeaders: { 'X-Two': '2' }, methods: [{ name: 'getVideos', get: 'o' }] });
		await made.api.getVideos();
		await other.getVideos();
		assert.deepEqual(ti.requests.map(request => [request.url, request.headers]), [
			['https://api.test/v1/videos', { 'X-One': '1' }],
			['https://other.test/o', { 'X-Two': '2' }]
		]);
	});

	it('clearCookies exists before the first request and targets the base URL', () => {
		const { api } = make();
		api.clearCookies(); // upstream defined clearCookies inside the first request
		assert.equal(ti.clients[0].cookiesCleared, 'https://api.test/v1/');
		api.clearCookies('https://other.test/');
		assert.equal(ti.clients[1].cookiesCleared, 'https://other.test/');
	});

	it('passes TLS and client options to the HTTP client without touching the defaults', async () => {
		const manager = { pinned: true };
		const { api } = make({ securityManager: manager, clientOptions: { tlsVersion: 4, autoRedirect: false, bogus: 1 } });
		await api.getVideos();
		assert.deepEqual(ti.clients[0].creation, { timeout: 10000, securityManager: manager, autoRedirect: false, tlsVersion: 4 });
		ti.uninstall();
		const plain = make({});
		await plain.api.getVideos();
		assert.deepEqual(ti.clients[0].creation, { timeout: 10000 }); // validatesSecureCertificate is not set unless configured
		ti.uninstall();
		const legacy = make({ validatesSecureCertificate: true });
		await legacy.api.getVideos();
		assert.equal(ti.clients[0].creation.validatesSecureCertificate, true);
	});

	it('creates no endpoint state until a method is first called', async () => {
		const { api } = make({ methods: [{ name: 'lazy', get: () => { throw new Error('evaluated'); } }, { name: 'used', get: 'used' }] });
		await api.used(); // defining `lazy` did not evaluate anything
		let handle;
		assert.doesNotThrow(() => {
			handle = api.lazy();
		});
		const error = await rejection(handle);
		assert.equal(error.kind, 'config');
		assert.match(error.message, /evaluated/);
		await wait();
	});
});

describe('method override', () => {
	// Titanium's Android HTTP client sends a DELETE without its body; the other platforms send it.
	const on = (osname) => {
		global.Ti.Platform.osname = osname;
	};

	it('is off unless configured: the request goes out as it is, and Android is told once that the body is lost', async () => {
		const warnings = [];
		const { api } = make({ logger: (level, message) => warnings.push(message) });
		on('android');
		await api.deleteVideo({ id: 1, body: { reason: 'x' } });
		await api.deleteVideo({ id: 2, body: { reason: 'y' } });
		assert.deepEqual(ti.requests.map(request => request.method), ['DELETE', 'DELETE']);
		assert.equal(ti.last.headers['X-HTTP-Method-Override'], undefined);
		assert.equal(warnings.filter(message => /drops it/.test(message)).length, 1);
	});

	it('sends a DELETE that has a body as POST with the real method in a header, where the platform would drop the body', async () => {
		const warnings = [];
		const events = [];
		const { api } = make({
			methodOverride: true, debug: true,
			logger: (level, message, details) => (details && details.event ? events.push(details.method) : warnings.push(message))
		});
		on('android');
		const response = await api.deleteVideo({ id: 1, body: { reason: 'x' } }, { fullResponse: true });
		assert.equal(ti.last.method, 'POST');
		assert.equal(ti.last.url, 'https://api.test/v1/videos/1');
		assert.equal(ti.last.headers['X-HTTP-Method-Override'], 'DELETE');
		assert.deepEqual(ti.last.json, { reason: 'x' });
		assert.equal(ti.last.headers['Content-Type'], 'application/json');
		// For the app it is the DELETE it asked for: the response, the log, interceptors and errors say so.
		assert.equal(response.method, 'DELETE');
		assert.deepEqual(events, ['DELETE', 'DELETE']);
		assert.deepEqual(warnings, []); // nothing is lost any more: no warning
	});

	it('leaves alone a DELETE without a body, the other methods, and a platform that sends the body', async () => {
		const { api } = make({ methodOverride: true });
		on('android');
		await api.deleteVideo({ id: 1 });
		await api.deleteVideo({ id: 1, body: {} });
		await api.putVideo({ id: 1, body: { a: 1 } });
		on('iphone');
		await api.deleteVideo({ id: 1, body: { reason: 'x' } });
		assert.deepEqual(ti.requests.map(request => request.method), ['DELETE', 'DELETE', 'PUT', 'DELETE']);
		ti.requests.forEach(request => assert.equal(request.headers['X-HTTP-Method-Override'], undefined));
		assert.deepEqual(ti.last.json, { reason: 'x' });
	});

	it('takes another header and other methods, can apply everywhere, and a method can decide for itself', async () => {
		const { api } = make({
			methodOverride: { header: 'X-Method', methods: ['DELETE', 'PATCH'], always: true },
			methods: METHODS.concat([{ name: 'plain', delete: 'plain/<id>', methodOverride: false }])
		});
		on('iphone');
		await api.patchVideo({ id: 1, body: { a: 1 } });
		await api.deleteVideo({ id: 1 });
		await api.plain({ id: 1, body: { a: 1 } });
		await api.putVideo({ id: 1, body: { a: 1 } });
		assert.deepEqual(ti.requests.map(request => [request.method, request.headers['X-Method']]),
			[['POST', 'PATCH'], ['POST', 'DELETE'], ['DELETE', undefined], ['PUT', undefined]]);
		ti.uninstall();
		const own = make({ methods: [{ name: 'remove', delete: 'things/<id>', methodOverride: true }, { name: 'other', delete: 'others/<id>' }] });
		on('android');
		await own.api.remove({ id: 1, body: { a: 1 } });
		await own.api.other({ id: 1, body: { a: 1 } });
		assert.deepEqual(ti.requests.map(request => [request.method, request.headers['X-HTTP-Method-Override']]), [['POST', 'DELETE'], ['DELETE', undefined]]);
	});

	it('does not make the request repeatable: it is still the DELETE it was, in the retry rules and in the error', async () => {
		const { api } = make({ methodOverride: true, retry: { retries: 2, baseDelay: 1, jitter: 0 } });
		on('android');
		ti.respond(() => ({ error: 'timeout' }));
		const error = await rejection(api.deleteVideo({ id: 1, body: { reason: 'x' } }));
		assert.equal(ti.requests.length, 1);
		assert.equal(error.kind, 'timeout');
		assert.equal(error.method, 'DELETE');
		// ... and one that is repeatable is repeated the same way.
		ti.respond(() => ({ status: 503 }));
		await rejection(api.deleteVideo({ id: 1, body: { reason: 'x' } }, { idempotencyKey: 'k' }));
		assert.deepEqual(ti.requests.slice(1).map(request => [request.method, request.headers['X-HTTP-Method-Override']]),
			[['POST', 'DELETE'], ['POST', 'DELETE'], ['POST', 'DELETE']]);
	});
});
