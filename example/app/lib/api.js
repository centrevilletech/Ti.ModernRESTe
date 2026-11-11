/**
 * The example's API layer: one RESTe instance, configured once.
 *
 * It talks to test/server/server.js of the RESTe repository (`npm run server`). The address comes from the
 * `reste.server` property in tiapp.xml; on an Android device run `adb reverse tcp:8787 tcp:8787` first.
 */
const Reste = require('reste');

const SERVER = Ti.App.Properties.getString('reste.server', 'http://127.0.0.1:8787/');

const METHODS = [
	{ name: 'health', get: 'health' },
	{ name: 'getThings', get: 'things' },
	{ name: 'getThing', get: 'things/<id>' },
	{ name: 'createThing', post: 'things' },
	{ name: 'updateThing', put: 'things/<id>' },
	{ name: 'patchThing', patch: 'things/<id>' },
	{ name: 'deleteThing', delete: 'things/<id>' },
	{ name: 'getItems', get: 'items', paginate: { style: 'page', perPage: 15 } },
	{ name: 'getMessages', get: 'messages', paginate: { style: 'cursor', limit: 20 } },
	{ name: 'upload', post: 'upload', multipart: true, timeout: 60000 },
	{ name: 'download', get: 'download/<size>', download: true, timeout: 60000 }
];

const MODELS = [{
	name: 'thing',
	read: 'getThing',
	create: 'createThing',
	update: 'updateThing',
	patch: 'patchThing',
	delete: 'deleteThing',
	content: 'data',
	identity: true,
	collections: [{ name: 'things', read: 'getThings', content: 'data', merge: true }]
}, {
	name: 'item',
	collections: [{ name: 'items', read: 'getItems', content: 'data', merge: true }]
}];

/** The settings every instance in this app shares; the checks build their own instances on top of them. */
function baseConfig(extra) {
	return Object.assign({
		url: SERVER,
		timeout: 8000,
		unwrap: 'data',
		meta: 'meta',
		retry: { retries: 2, baseDelay: 300 },
		dedupe: true
	}, extra);
}

function create() {
	const api = new Reste();
	api.config(baseConfig({ debug: false, methods: METHODS, models: MODELS }));
	return api;
}

module.exports = { create, baseConfig, Reste, SERVER, METHODS };
