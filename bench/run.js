#!/usr/bin/env node
'use strict';

/**
 * Library overhead, before and after: upstream RESTe (its master, read out of this repository's history)
 * against this build (reste.js), in Node with a Titanium HTTP client that answers synchronously, so only
 * the library's own work is measured.
 *
 *   npm run bench            (node --expose-gc bench/run.js)
 *   npm run bench -- --json  machine-readable results as well, in bench/results/
 *
 * Numbers from a desktop CPU are not device numbers; the example app prints the same measurements on a
 * phone (see example/README.md). What carries over is the ratio and the event counts.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { performance } = require('perf_hooks');

const root = path.join(__dirname, '..');
const UPSTREAM_REF = 'e54b51d'; // upstream master: "Merge pull request #78"

// ---------------------------------------------------------------- a synchronous Titanium

let responder = () => ({ status: 200, text: '{}' });
let requestCount = 0;

global.Ti = {
	Network: {
		online: true,
		createHTTPClient() {
			const client = {
				status: 0,
				responseText: null,
				responseHeaders: {},
				open(method, url) {
					client.method = method;
					client.url = url;
				},
				setRequestHeader() {},
				getResponseHeader(name) {
					return client.responseHeaders[name] || null;
				},
				abort() {},
				clearCookies() {},
				send(body) {
					requestCount++;
					const answer = responder(client, body);
					client.status = answer.status;
					client.responseText = answer.text;
					client.responseHeaders = answer.headers || {};
					if (answer.status >= 400) {
						client.onerror({ code: answer.status, error: 'HTTP error' });
					} else {
						client.onload({});
					}
				}
			};
			return client;
		}
	},
	Platform: { createUUID: () => 'uuid' }
};
global._ = require('underscore');

function loadUpstream() {
	const source = execFileSync('git', ['show', UPSTREAM_REF + ':reste.js'], { cwd: root, encoding: 'utf8' });
	const file = path.join(os.tmpdir(), 'reste-upstream-' + UPSTREAM_REF + '.js');
	fs.writeFileSync(file, source);
	return require(file);
}

const Upstream = loadUpstream();
const Fork = require(path.join(root, 'reste.js'));

// ---------------------------------------------------------------- measuring

function gc() {
	if (global.gc) {
		global.gc();
	}
}

/** Median wall time in ms of `fn`, over `runs` runs after `warmup` unmeasured ones. */
function time(fn, runs, warmup) {
	for (let i = 0; i < (warmup === undefined ? 3 : warmup); i++) {
		fn();
	}
	const samples = [];
	for (let i = 0; i < runs; i++) {
		gc();
		const started = performance.now();
		fn();
		samples.push(performance.now() - started);
	}
	samples.sort((a, b) => a - b);
	return samples[Math.floor(samples.length / 2)];
}

/** Approximate bytes allocated per call of `fn`: heap growth over a batch small enough to dodge the collector. */
function allocations(fn, batch) {
	let best = 0;
	for (let round = 0; round < 7; round++) {
		gc();
		const before = process.memoryUsage().heapUsed;
		for (let i = 0; i < batch; i++) {
			fn();
		}
		const grown = process.memoryUsage().heapUsed - before;
		if (grown > best) {
			best = grown;
		}
	}
	return Math.round(best / batch);
}

const results = [];

function report(name, unit, upstream, fork, note) {
	results.push({ name, unit, upstream, fork, note: note || '' });
}

function fmt(value, unit) {
	if (value === null || value === undefined) {
		return '-';
	}
	if (unit === 'ms') {
		return value < 10 ? value.toFixed(3) : value.toFixed(1);
	}
	if (unit === 'us') {
		return value.toFixed(2);
	}
	return String(Math.round(value));
}

function endpoints(count) {
	const methods = [];
	for (let i = 0; i < count; i++) {
		const verb = ['get', 'post', 'put', 'delete'][i % 4];
		const method = { name: 'method' + i };
		method[verb] = 'resource' + i + '/<id>/child/<child>';
		methods.push(method);
	}
	return methods;
}

function makeItems(count, changed) {
	const items = [];
	for (let i = 1; i <= count; i++) {
		items.push({
			id: i,
			title: 'Item ' + i + (changed && i <= changed ? ' (edited)' : ''),
			description: 'A reasonably long description for item number ' + i + ' so that rows have some weight to them.',
			status: ['open', 'offer_received', 'confirmed', 'done'][i % 4],
			price: i * 100,
			tags: ['a' + (i % 5), 'b' + (i % 7)],
			owner: { id: i % 20, name: 'Owner ' + (i % 20), avatar: 'https://cdn.example/avatars/' + (i % 20) + '.jpg' },
			created_at: '2026-01-01T00:00:00Z'
		});
	}
	return items;
}

// ---------------------------------------------------------------- 1. defining endpoints

(function defining() {
	const methods = endpoints(500);
	const upstream = time(() => {
		const api = new Upstream();
		api.config({ url: 'https://api.test/', methods });
	}, 31);
	const fork = time(() => {
		const api = new Fork();
		api.config({ url: 'https://api.test/', methods });
	}, 31);
	report('config() with 500 endpoints', 'ms', upstream, fork, 'the fork compiles an endpoint on its first call');

	const forkFirst = time(() => {
		const api = new Fork();
		api.config({ url: 'https://api.test/', methods });
		for (let i = 0; i < 20; i++) {
			api['method' + i]({ id: 1, child: 2 }, () => {});
		}
	}, 31);
	const upstreamFirst = time(() => {
		const api = new Upstream();
		api.config({ url: 'https://api.test/', methods });
		for (let i = 0; i < 20; i++) {
			api['method' + i]({ id: 1, child: 2 }, () => {});
		}
	}, 31);
	report('config() with 500 endpoints + first call of 20', 'ms', upstreamFirst, forkFirst, 'what app start actually pays');
}());

// ---------------------------------------------------------------- 2. one request

(function perRequest() {
	const config = () => ({
		url: 'https://api.test/',
		requestHeaders: { Accept: 'application/json', Authorization: () => 'Bearer token', 'X-App-Version': '1.0.0' },
		methods: [{ name: 'getThing', get: 'things/<id>' }, { name: 'postThing', post: 'things' }]
	});
	const upstream = new Upstream();
	upstream.config(config());
	const fork = new Fork();
	fork.config(config());
	const noop = () => {};
	const params = { id: 42 };
	const body = { body: { name: 'thing', count: 3 } };
	responder = () => ({ status: 200, text: '{"id":42,"name":"thing","count":3}' });
	const N = 20000;

	const upstreamGet = time(() => {
		for (let i = 0; i < N; i++) {
			upstream.getThing(params, noop, noop);
		}
	}, 15);
	const forkGet = time(() => {
		for (let i = 0; i < N; i++) {
			fork.getThing(params, noop, noop);
		}
	}, 15);
	report('GET with callbacks, small JSON', 'us', upstreamGet / N * 1000, forkGet / N * 1000, 'per request');

	const upstreamPost = time(() => {
		for (let i = 0; i < N; i++) {
			upstream.postThing(body, noop, noop);
		}
	}, 15);
	const forkPost = time(() => {
		for (let i = 0; i < N; i++) {
			fork.postThing(body, noop, noop);
		}
	}, 15);
	report('POST with callbacks, small JSON', 'us', upstreamPost / N * 1000, forkPost / N * 1000, 'per request');

	report('allocated per GET', 'bytes', allocations(() => upstream.getThing(params, noop, noop), 400),
		allocations(() => fork.getThing(params, noop, noop), 400), 'approximate; the fork also creates the promise and its handle');

	const full = new Fork();
	full.config(Object.assign(config(), {
		retry: true,
		dedupe: true,
		unwrap: 'data',
		interceptors: { request: request => request, response: response => response },
		onStatus: { 401: noop }
	}));
	const forkFull = time(() => {
		for (let i = 0; i < N; i++) {
			full.getThing(params, noop, noop);
		}
	}, 15);
	report('GET with retry, dedupe, interceptors, unwrap on', 'us', null, forkFull / N * 1000, 'per request, everything switched on');
}());

// ---------------------------------------------------------------- 3. a large list

(function largeList() {
	const text = JSON.stringify({ data: makeItems(500), meta: { total: 500 } });
	responder = () => ({ status: 200, text });
	const config = { url: 'https://api.test/', methods: [{ name: 'list', get: 'list' }] };
	const upstream = new Upstream();
	upstream.config(config);
	const fork = new Fork();
	fork.config(config);
	const noop = () => {};
	const upstreamTime = time(() => upstream.list({}, noop, noop), 201, 20);
	const forkTime = time(() => fork.list({}, noop, noop), 201, 20);
	report('GET a 500-item list (' + Math.round(text.length / 1024) + ' kB of JSON)', 'ms', upstreamTime, forkTime, 'upstream parses the text twice');

	const cached = new Fork();
	cached.config({ url: 'https://api.test/', methods: [{ name: 'list', get: 'list', cache: 'etag' }] });
	responder = client => ({ status: client.ifNoneMatch ? 304 : 200, text: client.ifNoneMatch ? '' : text, headers: { ETag: '"v1"' } });
	const originalFactory = global.Ti.Network.createHTTPClient;
	global.Ti.Network.createHTTPClient = function () {
		const client = originalFactory();
		const set = client.setRequestHeader;
		client.setRequestHeader = function (name, value) {
			if (name === 'If-None-Match') {
				client.ifNoneMatch = value;
			}
			return set.apply(this, arguments);
		};
		return client;
	};
	cached.list({}, noop, noop);
	const notModified = time(() => cached.list({}, noop, noop), 201, 20);
	global.Ti.Network.createHTTPClient = originalFactory;
	report('the same list again, ETag unchanged (304)', 'ms', upstreamTime, notModified, 'no body, no parse; upstream has no conditional requests');
}());

// ---------------------------------------------------------------- 4. collections

/**
 * One fetch that starts from `before` and receives `after`. Upstream finishes inside fetch(); this build
 * finishes a few microtasks later, so both are awaited.
 */
async function collections(version) {
	const Backbone = require('backbone-' + version);
	global.Backbone = Backbone;
	const bindingEvents = version === '0.9.2' ? 'fetch destroy change add remove reset' : 'fetch destroy change add remove reset sort';
	const initial = JSON.stringify({ data: makeItems(500) });
	const edited = JSON.stringify({ data: makeItems(500, 10) });
	const methods = [{ name: 'getItems', get: 'items' }];

	function scenario(Library, merge) {
		global.Alloy = { Collections: {}, Models: {}, Backbone };
		const api = new Library();
		api.config({
			url: 'https://api.test/',
			methods,
			models: [{ name: 'item', id: 'id', collections: [{ name: 'items', read: 'getItems', content: 'data', merge }] }]
		});
		const collection = global.Alloy.Collections.items;
		const counters = { renders: 0 };
		collection.on(bindingEvents, () => counters.renders++);
		return { collection, counters };
	}

	async function measure(Library, merge, before, after) {
		const samples = [];
		let renders = 0;
		for (let run = 0; run < 30; run++) {
			const made = scenario(Library, merge);
			if (before) {
				responder = () => ({ status: 200, text: before });
				await made.collection.fetch();
			}
			responder = () => ({ status: 200, text: after });
			made.counters.renders = 0;
			gc();
			const started = performance.now();
			await made.collection.fetch();
			if (run >= 5) {
				samples.push(performance.now() - started);
			}
			renders = made.counters.renders;
		}
		samples.sort((a, b) => a - b);
		return { ms: samples[Math.floor(samples.length / 2)], renders };
	}

	const label = 'Backbone ' + version + ': ';
	const rows = [
		['first fetch of 500 items', null, initial],
		['re-fetch, nothing changed', initial, initial],
		['re-fetch, 10 of 500 changed', initial, edited]
	];
	for (const row of rows) {
		const upstream = await measure(Upstream, false, row[1], row[2]);
		const fork = await measure(Fork, true, row[1], row[2]);
		report(label + row[0], 'ms', upstream.ms, fork.ms, 'merge: true');
		report(label + row[0] + ', renders of a bound list', 'count', upstream.renders, fork.renders,
			'events an Alloy dataCollection view re-renders on');
	}
	const plain = await measure(Fork, false, initial, edited);
	report(label + 're-fetch, 10 of 500 changed, merge off', 'ms', null, plain.ms, "Backbone's own fetch, as upstream");
	report(label + 're-fetch, 10 of 500 changed, merge off, renders', 'count', null, plain.renders, '');
}

// ---------------------------------------------------------------- 5. the longest block on the UI thread

async function longestBlock() {
	const Backbone = require('backbone-1.4.0');
	global.Backbone = Backbone;
	const text = JSON.stringify({ data: makeItems(2000) });

	async function run(chunk) {
		global.Alloy = { Collections: {}, Models: {}, Backbone };
		const api = new Fork();
		api.config({
			url: 'https://api.test/',
			chunk,
			methods: [{ name: 'getItems', get: 'items' }],
			models: [{ name: 'item', id: 'id', collections: [{ name: 'items', read: 'getItems', content: 'data', merge: true }] }]
		});
		responder = () => ({ status: 200, text });
		gc();
		await new Promise(resolve => setTimeout(resolve, 20));
		let longest = 0;
		let last = performance.now();
		const tick = () => {
			const now = performance.now();
			longest = Math.max(longest, now - last);
			last = now;
		};
		const ticker = setInterval(tick, 0);
		const started = performance.now();
		await global.Alloy.Collections.items.fetch();
		tick();
		clearInterval(ticker);
		return { longest, total: performance.now() - started };
	}

	const samples = { whole: [], chunked: [] };
	for (let i = 0; i < 9; i++) {
		samples.whole.push(await run(0));
		samples.chunked.push(await run(100));
	}
	const median = (list, key) => list.map(item => item[key]).sort((a, b) => a - b)[Math.floor(list.length / 2)];
	report('merging 2000 items: longest block on the thread', 'ms', null, median(samples.whole, 'longest'), 'chunk: 0 (one block)');
	report('merging 2000 items: longest block on the thread', 'ms', null, median(samples.chunked, 'longest'), 'chunk: 100');
	report('merging 2000 items: total time', 'ms', null, median(samples.whole, 'total'), 'chunk: 0');
	report('merging 2000 items: total time', 'ms', null, median(samples.chunked, 'total'), 'chunk: 100 (timers add about 1 ms per chunk)');
}

// ---------------------------------------------------------------- loading the library

const vm = require('vm');
let fresh = 0;

/**
 * Loads a CommonJS file the way a cold start does: its text is compiled and run as a new module every time
 * (a comment makes each text unique, so the engine has nothing cached). './reste.data' resolves to the second
 * file of the two-file build, loaded the same way.
 */
function coldRequire(file) {
	const source = fs.readFileSync(file, 'utf8') + '\n// ' + (++fresh);
	const script = new vm.Script('(function (module, exports, require) {' + source + '\n})', { filename: 'cold-' + fresh + '.js' });
	const loaded = { exports: {} };
	script.runInThisContext()(loaded, loaded.exports, name => (name === './reste.data' ? coldRequire(path.join(path.dirname(file), 'reste.data.js')) : require(name)));
	return loaded.exports;
}

function loading() {
	const upstreamFile = path.join(os.tmpdir(), 'reste-upstream-' + UPSTREAM_REF + '.js');
	const single = path.join(root, 'reste.js');
	const split = path.join(root, 'split', 'reste.js');
	const methods = endpoints(20);
	const firstRequest = (file) => {
		const Reste = coldRequire(file);
		const api = new Reste();
		api.config({ url: 'https://api.test/', methods });
		api[methods[0].name]({}, () => {}, () => {});
		return api;
	};
	const firstMerge = (file) => {
		const api = firstRequest(file);
		api.upsert(new (require('backbone-1.4.0').Collection)(), [{ id: 1 }]);
	};
	report('load the library (compile and run its file)', 'ms', time(() => coldRequire(upstreamFile), 60), time(() => coldRequire(single), 60),
		'the one-file build: ' + Math.round(fs.statSync(single).size / 1024) + ' kB against ' + Math.round(fs.statSync(upstreamFile).size / 1024) + ' kB');
	report('load the library, two-file build', 'ms', null, time(() => coldRequire(split), 60),
		'models, collections, lists and pagination stay in the second file until first used');
	report('load, config() with 20 endpoints, first request', 'ms', time(() => firstRequest(upstreamFile), 60), time(() => firstRequest(single), 60), 'a cold start, one-file build');
	report('load, config() with 20 endpoints, first request, two-file build', 'ms', null, time(() => firstRequest(split), 60), 'a cold start that only sends requests');
	report('the same, then the first merge into a collection', 'ms', null, time(() => firstMerge(single), 60), 'one-file build');
	report('the same, then the first merge, two-file build', 'ms', null, time(() => firstMerge(split), 60), 'reads the second file');
}

// ---------------------------------------------------------------- output

async function main() {
	loading();
	await collections('1.4.0');
	await collections('0.9.2');
	await longestBlock();
	const rows = results.map(row => [row.name, row.unit, fmt(row.upstream, row.unit), fmt(row.fork, row.unit),
		row.upstream && row.fork ? (row.upstream / row.fork).toFixed(2) + 'x' : '-', row.note]);
	const header = ['measurement', 'unit', 'upstream', 'this build', 'ratio', 'note'];
	const widths = header.map((title, column) => Math.max(title.length, ...rows.map(row => row[column].length)));
	const line = cells => cells.map((cell, column) => (column >= 2 && column <= 4 ? cell.padStart(widths[column]) : cell.padEnd(widths[column]))).join('  ');
	console.log('node ' + process.version + ', ' + os.cpus()[0].model + ', upstream ' + UPSTREAM_REF + ' vs reste.js ' + Fork.version + '\n');
	console.log(line(header));
	console.log(widths.map(width => '-'.repeat(width)).join('  '));
	rows.forEach(row => console.log(line(row)));
	console.log('\n' + requestCount + ' requests answered by the fake HTTP client');
	if (process.argv.includes('--json')) {
		const dir = path.join(__dirname, 'results');
		fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, 'bench-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
		fs.writeFileSync(file, JSON.stringify({ node: process.version, cpu: os.cpus()[0].model, upstream: UPSTREAM_REF, version: Fork.version, results }, null, '\t'));
		console.log('wrote ' + file);
	}
}

main();
