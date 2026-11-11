#!/usr/bin/env node
'use strict';

/**
 * Mutation check: breaks one safety-relevant line of the sources at a time and runs the suite against it.
 * Every mutation must make at least one test fail; one that survives is a hole in the tests.
 *
 *   npm run mutate              all mutations, several at a time (a few minutes)
 *   npm run mutate -- retry     only those whose name contains "retry"
 *
 * Each mutation is [name, file, text to find, replacement]. A text that is no longer in the file is reported
 * as "pattern not found": the mutation has to be brought up to date with the code.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const root = path.join(__dirname, '..');

const MUTATIONS = [
	// ---- what may be sent again
	['retry: any method is repeatable', 'src/retry.js', 'return policy.methods.indexOf(request.method) !== -1;', 'return true;'],
	['retry: a per-call retry makes the request repeatable', 'src/client.js', 'endpointRetry: ctx.endpoint.repeatable,', 'endpointRetry: ctx.endpoint.repeatable || ctx.options.retry !== undefined,'],
	['retry: Retry-After ignored', 'src/retry.js', 'if (policy.retryAfter && error && error.retryAfter != null) {', 'if (false) {'],
	['retry: a new idempotency key per attempt', 'src/client.js', 'ctx.attempt++;\n\t\ttry {', 'ctx.attempt++;\n\t\tif (ctx.idempotencyKey) {\n\t\t\tctx.idempotencyKey = state.keys.generate();\n\t\t}\n\t\ttry {'],
	['hooks: "retry" re-sends unsafe requests after any status', 'src/client.js', '|| state.authStatuses.indexOf(status) !== -1;', '|| true;'],
	['hooks: fire once per request instead of once per event', 'src/client.js', 'if (!episode || episode.generation !== state.generation || (!episode.pending && ctx.sentSeq > episode.seq)) {', 'if (true) {'],

	// ---- sessions
	['session: a waiting retry is sent after a reset', 'src/client.js', 'if (outdated(ctx)) {\n\t\t\t// A retry that was waiting', 'if (false) {\n\t\t\t// A retry that was waiting'],
	['session: a request held by an interceptor is sent after a reset', 'src/client.js', 'if (outdated(ctx)) {\n\t\t\t// An interceptor or a hook held', 'if (false) {\n\t\t\t// An interceptor or a hook held'],
	['optimistic: protection ends with the write, not with the loads asked for before it', 'src/sync.js', 'if (activeLoads.size === 0) {\n\t\t\trun();\n\t\t} else {\n\t\t\tloadWaiters.push({ pending: new Set(activeLoads), run });\n\t\t}', 'run();'],
	['session: late responses are delivered', 'src/client.js', 'if (ctx.endpoint.session !== false && ctx.generation !== state.generation) {\n\t\t\tfail(', 'if (false) {\n\t\t\tfail('],
	['session: requests of two sessions are joined', 'src/client.js', "key += '\\nsession:' + ctx.generation;", "key += '';"],
	['session: a reset inside a status hook drops the answer that fired it', 'src/client.js', 'ctx.generation === state.generation || ctx.answered) {', 'ctx.generation === state.generation) {'],
	['hooks: a firing the hook declined still swallows the next response', 'src/client.js', 'asks for itself.\n\t\t\t\tforget(status, episode);', 'asks for itself.'],
	['session: a request re-sent by a hook escapes the next reset', 'src/client.js', 'ctx.answered = false; // on its way again', '// on its way again'],
	['log: redact.allow exempts nothing', 'src/logger.js', 'if (!plain || allowed.indexOf(plain) !== -1) {', 'if (!plain) {'],
	['session: reset keeps idempotency actions', 'src/index.js', 'state.keys.clear();\n\t\t\tif (settings.clearCache', 'if (settings.clearCache'],
	['session: reset keeps the collections\' paging', 'src/sync.js', 'if (meta.pager) {\n\t\t\t\t\tmeta.pager.reset();\n\t\t\t\t}', ''],

	// ---- a call never throws
	['a throwing header function escapes', 'src/client.js', 'try {\n\t\t\tctx.headers = resolveHeaders(ctx);\n\t\t} catch (error) {\n\t\t\tabandon(ctx, toResteError(error));\n\t\t\treturn;\n\t\t}', 'ctx.headers = resolveHeaders(ctx);'],
	['a failure before sending does not reach callers that share the request', 'src/client.js', 'if (ctx.shared) {\n\t\t\t\tsettle(ctx, { error, status: 0, http: null, body: undefined });\n\t\t\t} else {\n\t\t\t\tfailed(ctx, error);\n\t\t\t}', 'failed(ctx, error);'],

	['errors: a cancelled request rejects without the app\'s mapper', 'src/client.js', 'ctx.handle.catch(noop);\n\t\t\tctx.reject(mapped);', 'ctx.handle.catch(noop);\n\t\t\tctx.reject(error);'],

	// ---- credentials
	['log: query values not redacted', 'src/logger.js', "const mark = out.indexOf('?');", 'const mark = -1;'],
	['log: body fields not redacted', 'src/logger.js', 'out[keys[i]] = sensitive(keys[i]) ? REDACTED : redactValue(value[keys[i]], depth + 1);', 'out[keys[i]] = redactValue(value[keys[i]], depth + 1);'],
	['log: headers not redacted', 'src/logger.js', 'out[keys[i]] = sensitive(keys[i]) ? REDACTED : headers[keys[i]];', 'out[keys[i]] = headers[keys[i]];'],
	['log: string bodies printed as they are', 'src/logger.js', "if (typeof body !== 'string') {\n\t\t\treturn redactValue(body, 0);\n\t\t}", 'if (true) {\n\t\t\treturn redactValue(body, 0);\n\t\t}'],
	['log: path values not redacted', 'src/client.js', 'url = url.split(encodeURIComponent(text)).join(log.redacted).split(text).join(log.redacted);', ''],
	['headers: defaults go to every origin', 'src/client.js', ': !endpoint.absolute || sameOrigin(ctx.url, state.config.url);', ': true;'],
	['headers: globalHeaders: false ignored', 'src/client.js', 'const wanted = endpoint.globalHeaders !== undefined ? endpoint.globalHeaders', 'const wanted = endpoint.globalHeaders === 0 ? endpoint.globalHeaders'],

	// ---- cache
	['cache: an answer invalidated in flight is stored', 'src/client.js', 'outcome.status >= 200 && outcome.status < 300 && current(ctx)) {', 'outcome.status >= 200 && outcome.status < 300) {'],
	['cache: a 304 restores an invalidated entry', 'src/client.js', 'if (current(ctx)) {\n\t\t\t\tstate.cache.revalidated(', 'if (true) {\n\t\t\t\tstate.cache.revalidated('],
	['cache: every response header is persisted', 'src/cache.js', 'PERSISTED_HEADERS.forEach((name) => {\n\t\t\tif (entry.headers && entry.headers[name] !== undefined) {\n\t\t\t\theaders[name] = entry.headers[name];\n\t\t\t}\n\t\t});', 'Object.assign(headers, entry.headers);'],
	['cache: responses that vary on credentials go to disk', 'src/cache.js', 'const toDisk = Boolean(policy.persist && store && !personal);', 'const toDisk = Boolean(policy.persist && store);'],
	['cache: Vary ignored on lookup', 'src/cache.js', 'if (!entry || (requestHeader && !sameVariant(entry, requestHeader))) {', 'if (!entry) {'],
	['cache: clear() keeps the store', 'src/cache.js', '\t\tclear() {\n\t\t\tversions.all++;\n\t\t\tmemory.clear();\n\t\t\tstoredNames().forEach((name) => {', '\t\tclear() {\n\t\t\tversions.all++;\n\t\t\tmemory.clear();\n\t\t\t[].forEach((name) => {'],
	['cache: invalidation by name skips persisted entries', 'src/cache.js', 'match = name.indexOf(wanted) === 0;', 'match = false;'],
	['cache: no-store ignored', 'src/cache.js', "if (control['no-store']) {\n\t\t\treturn null;\n\t\t}", ''],
	['cache: a 200 with the validator sent is parsed again', 'src/client.js', "|| (outcome.status === 200 && entry.etag && transport.readHeader(http, 'ETag') === entry.etag))) {", ')) {'],
	['cache: stale-if-error off', 'src/client.js', 'if (!afterResponse && policy && policy.staleIfError && ctx.cacheEntry', 'if (false && ctx.cacheEntry'],
	['dedupe: a reload joins a conditional request', 'src/client.js', "key += '\\nif:' + (ctx.cacheEntry ? ctx.cacheEntry.etag || ctx.cacheEntry.lastModified || '' : '');", "key += '';"],
	['dedupe: the network keeps running when every caller aborted', 'src/client.js', 'if (shared.refs <= 0) {\n\t\t\tstopNetwork(shared.lead);', 'if (shared.refs <= 0) {\n\t\t\t'],

	// ---- cancelling
	['abort leaves the back-off timer', 'src/client.js', 'if (ctx.timer) {\n\t\t\tclearTimeout(ctx.timer);\n\t\t\tctx.timer = null;\n\t\t}\n\t\tif (ctx.transport) {', 'if (ctx.transport) {'],
	['cancelled requests call the error callback', 'src/client.js', 'ctx.handle.catch(noop);\n\t\t\tctx.reject(mapped);\n\t\t\treturn;', 'ctx.handle.catch(noop);\n\t\t\tctx.reject(mapped);'],
	['deadline ignored', 'src/client.js', 'if (deadline > 0) {\n\t\t\tctx.deadlineTimer', 'if (false) {\n\t\t\tctx.deadlineTimer'],
	['timeouts reported as network errors', 'src/errors.js', "if (TIMEOUT_PATTERN.test(message) || code === -1001) {\n\t\treturn 'timeout';\n\t}\n\tif (timeout > 0 && elapsed >= timeout) {\n\t\treturn 'timeout';\n\t}", ''],

	// ---- requests
	['path values not encoded', 'src/url.js', 'out += encode ? encodeURIComponent(value) : value;', 'out += value;'],
	['an empty path value is sent', 'src/url.js', "(value === '' && !template.inQuery[i])", 'false'],
	['multipart keeps the JSON content type', 'src/client.js', 'if (typeKey) {\n\t\t\t\tdelete headers[typeKey];\n\t\t\t}\n\t\t\treturn flattenFields(body);', 'return flattenFields(body);'],
	['progress not stepped', 'src/transport.js', 'const least = step === undefined || step === null ? 0.01 : step;', 'const least = 0;'],
	['a JSON parse error is swallowed', 'src/client.js', "if (type.indexOf('json') !== -1) {\n\t\t\tthrow ResteError('parse'", "if (false) {\n\t\t\tthrow ResteError('parse'"],

	// ---- models and collections
	['models: the configured id attribute is not copied to id', 'src/sync.js', 'if (attrs.id === undefined && attrs[sourceId] != null && !(settings && settings.unset)) {', 'if (false) {'],
	['models: beforeCreate and beforeDelete swapped back', 'src/sync.js', 'if (isFunction(config.beforeCreate)) {\n\t\t\t\tparams.body = config.beforeCreate(params.body, model);', 'if (isFunction(config.beforeDelete)) {\n\t\t\t\tparams.body = config.beforeDelete(params.body, model);'],
	['merge: unchanged attributes are set again', 'src/attributes.js', 'if (a === b) {\n\t\t\tcontinue;\n\t\t}\n\t\tif (isObject(a) && isObject(b) && deepEqual(a, b)) {\n\t\t\tcontinue;\n\t\t}', ''],
	['merge: one event per row', 'src/merge.js', "const coalesce = settings.events !== 'each';", 'const coalesce = false;'],
	['merge: the identity map is not consulted', 'src/merge.js', 'return collection.get(id) || pending.get(id) || (identity ? identity.get(id) : undefined);', 'return collection.get(id) || pending.get(id);'],
	['merge: a refresh re-adds a model that is being destroyed', 'src/merge.js', 'if (destroying && destroying.has(attrs[idAttribute])) {\n\t\t\t\t\t\t\tcontinue;', 'if (false) {\n\t\t\t\t\t\t\tcontinue;'],
	['merge: a refresh reverts an optimistic change', 'src/attributes.js', 'if (pending && pending[key] > 0) {\n\t\t\tcontinue;', 'if (false) {\n\t\t\tcontinue;'],
	['merge: a refresh drops a model that is being created', 'src/merge.js', 'if (model._pendingCreate && !wanted.has(model)) {', 'if (false) {'],
	['optimistic: rollback restores everything', 'src/sync.js', 'if (deepEqual(model.get(name), attrs[name])) {\n\t\t\t\t\tif (previous[name] === undefined) {', 'if (true) {\n\t\t\t\t\tif (previous[name] === undefined) {'],
	['identity: the map never drops a model', 'src/identity.js', '} else if (map.size > limit) {\n\t\t\t\ttrim();', '} else if (false) {\n\t\t\t\ttrim();'],
	['pager: duplicate rows kept', 'src/pagination.js', 'if (seen.has(id)) {\n\t\t\t\treturn false;', 'if (false) {\n\t\t\t\treturn false;'],
	['list: the filter is ignored when a model joins', 'src/list.js', 'if (loaded && model && filter(model)) {\n\t\t\tinsert(model);', 'if (loaded && model) {\n\t\t\tinsert(model);'],
	['function URLs: compiled variants are never dropped', 'src/index.js', 'if (cache.size >= MAX_VARIANTS) {', 'if (false) {']
];

const filter = process.argv[2];
const chosen = MUTATIONS.filter(mutation => !filter || mutation[0].indexOf(filter) !== -1);
const workers = Math.min(Math.max(2, Math.floor(os.cpus().length / 4)), 8, chosen.length);
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'reste-mutate-'));
let next = 0;
let survived = 0;
let outdated = 0;

function copy(from, to) {
	fs.cpSync(from, to, { recursive: true });
}

function run(worker) {
	if (next >= chosen.length) {
		return Promise.resolve();
	}
	const index = next++;
	const mutation = chosen[index];
	const dir = path.join(base, 'worker-' + worker);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	['src', 'test', 'package.json'].forEach(name => copy(path.join(root, name), path.join(dir, name)));
	fs.symlinkSync(path.join(root, 'node_modules'), path.join(dir, 'node_modules'));
	fs.symlinkSync(path.join(root, '.git'), path.join(dir, '.git')); // the differential test reads upstream from history
	const file = path.join(dir, mutation[1]);
	const source = fs.readFileSync(file, 'utf8');
	if (source.indexOf(mutation[2]) === -1) {
		outdated++;
		console.log('PATTERN NOT FOUND  ' + mutation[0] + '  (' + mutation[1] + ')');
		return run(worker);
	}
	fs.writeFileSync(file, source.replace(mutation[2], mutation[3]));
	return new Promise((resolve) => {
		execFile(process.execPath, ['--test', 'test/unit/*.test.js', 'test/integration/*.test.js'], { cwd: dir, timeout: 600000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
			const failed = /# fail (\d+)/.exec(stdout || '');
			const count = failed ? Number(failed[1]) : 0;
			const first = /^\s+not ok \d+ - (.*)$/m.exec(stdout || '');
			if (count === 0 && !error) {
				survived++;
				console.log('SURVIVED           ' + mutation[0]);
			} else {
				console.log('caught (' + String(count).padStart(3) + ' fail)  ' + mutation[0] + (first ? '  e.g. ' + first[1].slice(0, 70) : ''));
			}
			resolve(run(worker));
		});
	});
}

Promise.all(Array.from({ length: workers }, (unused, worker) => run(worker))).then(() => {
	fs.rmSync(base, { recursive: true, force: true });
	console.log('\n' + chosen.length + ' mutations: ' + (chosen.length - survived - outdated) + ' caught, ' + survived + ' survived, ' + outdated + ' out of date');
	process.exit(survived || outdated ? 1 : 0);
});
