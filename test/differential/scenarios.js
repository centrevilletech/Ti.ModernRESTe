'use strict';

/*
 * What apps written for RESTe 1.x do, taken from upstream's README: every scenario here runs against upstream
 * and against this build (runner.js), and test/unit/differential.test.js compares what they did: the
 * callbacks called, their arguments, and the requests sent.
 */

const base = extra => Object.assign({
	url: 'https://api.test/1/',
	timeout: 4000,
	requestHeaders: { 'X-App-Id': 'APPID', 'Content-Type': 'application/json' },
	methods: [
		{ name: 'getVideos', get: 'classes/videos' },
		{ name: 'getVideoById', get: 'classes/videos/<videoId>' },
		{ name: 'addVideo', post: 'classes/videos' },
		{ name: 'updateVideo', put: 'classes/videos/<objectId>' },
		{ name: 'deleteVideo', delete: 'classes/videos/<objectId>' },
		{ name: 'search', get: 'classes/locations?where={"name": "<name>"}' },
		{ name: 'push', post: 'http://another.api.test/push' },
		{ name: 'sameHost', post: 'https://api.test/2/other' }
	]
}, extra);

const withModels = extra => Object.assign({
	url: 'https://api.test/1/',
	errorsAsObjects: true,
	requestHeaders: { 'Content-Type': 'application/json' },
	models: [{
		name: 'location',
		id: 'objectId',
		read: 'getLocation',
		create: 'createLocation',
		update: 'updateLocation',
		delete: 'deleteLocation',
		transform(model) {
			const json = model.toJSON();
			json.upper = String(json.name || '').toUpperCase();
			return json;
		},
		collections: [
			{ name: 'locations', content: 'results', read: 'getLocations' },
			{ name: 'locationsByName', content: 'results', read: 'getLocationsByName' }
		]
	}],
	methods: [
		{ name: 'getLocations', get: 'classes/locations' },
		{ name: 'getLocation', get: 'classes/locations/<objectId>' },
		{ name: 'getLocationsByName', get: 'classes/locations?where={"name": "<name>"}' },
		{ name: 'updateLocation', put: 'classes/locations/<objectId>' },
		{ name: 'createLocation', post: 'classes/locations/' },
		{ name: 'deleteLocation', delete: 'classes/locations/<objectId>' }
	]
}, extra);

/** The fields of an error object that 1.x documents. */
const errorFields = error => (error && typeof error === 'object'
	? { code: error.code, content: error.content, success: error.success, type: error.type }
	: error);

function make(Reste, config) {
	const api = new Reste();
	api.config(config);
	return api;
}

module.exports = {
	// ------------------------------------------------------------ calls
	async 'GET with a callback'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: { results: [{ id: 1 }] } }));
		const handle = make(Reste, base()).getVideos(videos => record('onLoad', videos));
		record('the return value can abort', typeof handle.abort);
		await wait(20);
	},
	async 'GET with a path parameter'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: { id: 'x' } }));
		make(Reste, base()).getVideoById({ videoId: 'fUAM4ZFj9X' }, video => record('onLoad', video));
		await wait(20);
	},
	async 'POST with a body'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 201, body: { objectId: 'n1' } }));
		make(Reste, base()).addVideo({ body: { categoryId: 1, name: 'My Video' } }, video => record('onLoad', video));
		await wait(20);
	},
	async 'PUT with an id and a body'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: { ok: 1 } }));
		make(Reste, base()).updateVideo({ objectId: '123', body: { name: 'v2' } }, video => record('onLoad', video));
		await wait(20);
	},
	async 'DELETE without a body'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		make(Reste, base()).deleteVideo({ objectId: '123' }, result => record('onLoad', result));
		await wait(20);
	},
	async 'POST without params'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		make(Reste, base()).addVideo(result => record('onLoad', result));
		await wait(20);
	},
	async 'a placeholder inside a query string'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: { results: [] } }));
		make(Reste, base()).search({ name: 'home' }, result => record('onLoad', result));
		await wait(20);
	},
	async 'a path value that needs encoding'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		make(Reste, base()).getVideoById({ videoId: 'a b/c' }, () => record('onLoad'));
		await wait(20);
	},
	async 'an empty string for a placeholder in the query'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: { results: [] } }));
		make(Reste, base()).search({ name: '' }, result => record('onLoad', result), () => record('onError'));
		await wait(20);
	},
	async 'an empty string for a placeholder in the path'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		make(Reste, base()).getVideoById({ videoId: '' }, () => record('onLoad'), () => record('onError'));
		await wait(20);
	},
	async 'an object for a placeholder'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		make(Reste, base()).search({ name: { a: 1 } }, () => record('onLoad'));
		await wait(20);
	},
	async 'parameters that are not placeholders are ignored'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		make(Reste, base()).getVideos({ page: 2, other: 'abc' }, () => record('onLoad'));
		await wait(20);
	},
	async 'a missing placeholder without validation'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		make(Reste, base()).getVideoById({}, () => record('onLoad'), () => record('onError'));
		await wait(20);
	},
	async 'a missing placeholder with autoValidateParams'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		const api = make(Reste, base({ autoValidateParams: true }));
		try {
			api.getVideoById({}, () => record('onLoad'), () => record('onError'));
		} catch (error) {
			record('threw');
		}
		await wait(20);
	},
	async 'expects with a missing parameter'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		const config = base();
		config.methods.push({ name: 'login', post: 'login', expects: ['email', 'password'] });
		const api = make(Reste, config);
		try {
			api.login({ body: { email: 'a' } }, () => record('onLoad'), () => record('onError'));
		} catch (error) {
			record('threw');
		}
		await wait(20);
	},
	async 'a string body'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		make(Reste, base()).addVideo({ body: 'raw text' }, () => record('onLoad'));
		await wait(20);
	},
	async 'a form-encoded body'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		make(Reste, base({ requestHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' } })).addVideo({ body: { a: 1, b: 'two' } }, () => record('onLoad'));
		await wait(20);
	},
	async 'a method with a full URL on another host'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		make(Reste, base()).push({ body: { a: 1 } }, () => record('onLoad'));
		await wait(20);
	},
	async 'a method with a full URL on the same host'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		make(Reste, base()).sameHost({ body: { a: 1 } }, () => record('onLoad'));
		await wait(20);
	},
	async 'the timeout of a method and of the config'({ Reste, ti, record, wait }) {
		ti.respond((request) => {
			record('timeout', request.client.timeout);
			return { status: 200, body: {} };
		});
		const config = base();
		config.methods.push({ name: 'slow', get: 'slow', timeout: 30000 });
		const api = make(Reste, config);
		api.slow(() => {});
		api.getVideos(() => {});
		await wait(20);
	},
	async 'setUrl and getUrl'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		const api = make(Reste, base());
		api.setUrl('https://staging.test/1/');
		record('getUrl', api.getUrl());
		api.getVideos(() => record('onLoad'));
		await wait(20);
	},
	async 'config() twice'({ Reste, record }) {
		const api = make(Reste, base());
		try {
			api.config(base());
			record('second config accepted');
		} catch (error) {
			record('threw');
		}
	},
	async 'a method defined twice'({ Reste, record }) {
		const api = make(Reste, base());
		try {
			api.addMethod({ name: 'getVideos', get: 'x' });
			record('accepted');
		} catch (error) {
			record('threw');
		}
	},

	async 'method(onLoad, onError) without params'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: { ok: true } }));
		make(Reste, base()).getVideos(result => record('onLoad', result), () => record('onError'));
		await wait(20);
	},
	async 'a JSON body without a Content-Type header configured'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		make(Reste, base({ requestHeaders: {} })).addVideo({ body: { a: 1 } }, () => record('onLoad'));
		await wait(20);
	},
	async 'a form-encoded body with nested values'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		make(Reste, base({ requestHeaders: { 'Content-Type': 'application/x-www-form-urlencoded' } })).addVideo({ body: { a: 1, flag: true, nested: { c: 3 } } }, () => record('onLoad'));
		await wait(20);
	},

	// ------------------------------------------------------------ responses
	async 'a 204 without a body'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 204, text: '' }));
		make(Reste, base()).deleteVideo({ objectId: 1 }, result => record('onLoad', result), () => record('onError'));
		await wait(20);
	},
	async 'a text response'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, text: 'OK', headers: { 'Content-Type': 'text/plain' } }));
		make(Reste, base()).getVideos({}, result => record('onLoad', result), () => record('onError'));
		await wait(20);
	},
	async 'text that claims to be JSON'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, text: 'OK', headers: { 'Content-Type': 'application/json' } }));
		make(Reste, base()).getVideos({}, result => record('onLoad', result), () => record('onError'));
		await wait(20);
	},
	async 'JSON null'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, text: 'null', headers: { 'Content-Type': 'application/json' } }));
		make(Reste, base()).getVideos(result => record('onLoad', result));
		await wait(20);
	},
	async 'a success callback that throws'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: { v: 1 } }));
		make(Reste, base()).getVideos(() => {
			record('onLoad');
			throw new Error('a bug in the app');
		});
		await wait(20);
	},

	// ------------------------------------------------------------ errors
	async 'a 404 with only a success callback'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 404, body: { error: 'nope' } }));
		make(Reste, base()).getVideos(result => record('onLoad', result));
		await wait(20);
	},
	async 'a 404 with an error callback'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 404, body: { error: 'nope' } }));
		make(Reste, base()).getVideos({}, () => record('onLoad'), (error, retry) => record('onError', error, typeof retry));
		await wait(20);
	},
	async 'a 401 with errorsAsObjects'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 401, body: { error: 'invalid_credentials' } }));
		make(Reste, base({ errorsAsObjects: true })).getVideos({}, () => record('onLoad'), (error, retry) => record('onError', errorFields(error), typeof retry));
		await wait(20);
	},
	async 'the url and the error text of an error object'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 500, body: {} }));
		make(Reste, base({ errorsAsObjects: true })).getVideos({}, () => record('onLoad'), error => record('onError', error.url, error.error));
		await wait(20);
	},
	async 'a 422 with errorsAsObjects: false'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 422, body: { message: 'bad' } }));
		make(Reste, base({ errorsAsObjects: false })).getVideos({}, () => record('onLoad'), error => record('onError', error));
		await wait(20);
	},
	async 'errorsAsObjects: false with only a success callback'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 422, body: { message: 'bad' } }));
		make(Reste, base({ errorsAsObjects: false })).getVideos(result => record('onLoad', result));
		await wait(20);
	},
	async 'the README sample that tests e.message'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 500, body: { message: 'The API said so' } }));
		const config = base({ errorsAsObjects: false });
		config.methods.push({
			name: 'courses',
			post: 'functions/getCourses',
			onError(error) {
				record(error.message ? 'alert: ' + error.message : 'global handler');
			}
		});
		make(Reste, config).courses({ body: {} }, () => record('onLoad'));
		await wait(20);
	},
	async 'the README sample that tests e.message, with the default error setting'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 500, body: { message: 'The API said so' } }));
		const config = base();
		config.methods.push({
			name: 'courses',
			post: 'functions/getCourses',
			onError(error) {
				record(error.message ? 'alert: ' + error.message : 'global handler');
			}
		});
		make(Reste, config).courses({ body: {} }, () => record('onLoad'));
		await wait(20);
	},
	async 'a network failure'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 0, error: 'Unable to resolve host' }));
		make(Reste, base({ errorsAsObjects: true })).getVideos({}, () => record('onLoad'), error => record('onError', error.error));
		await wait(20);
	},
	async 'config.onError and its retry'({ Reste, ti, record, wait }) {
		let sent = 0;
		ti.respond(() => (++sent === 1 ? { status: 500, body: { e: 1 } } : { status: 200, body: { ok: sent } }));
		const api = make(Reste, base({
			errorsAsObjects: true,
			onError(error, retry) {
				record('config.onError', errorFields(error));
				retry();
			}
		}));
		api.getVideos(result => record('onLoad', result));
		await wait(40);
	},
	async 'config.onLoad'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: { a: 1 } }));
		const api = make(Reste, base({
			onLoad(body, callback) {
				record('config.onLoad', body);
				callback(Object.assign({ wrapped: true }, body));
			}
		}));
		api.getVideos(result => record('onLoad', result));
		await wait(20);
	},
	async 'a method with onLoad and onError'({ Reste, ti, record, wait }) {
		let sent = 0;
		ti.respond(() => (++sent === 1 ? { status: 200, body: { a: 1 } } : { status: 500, body: { b: 2 } }));
		const config = base({ errorsAsObjects: true });
		config.methods.push({
			name: 'courses',
			post: 'functions/getCourses',
			onLoad(body, callback) {
				record('method.onLoad', body);
				callback(body);
			},
			onError(error, callback) {
				record('method.onError', errorFields(error), typeof callback);
			}
		});
		const api = make(Reste, config);
		api.courses({ body: { x: 1 } }, result => record('onLoad', result), () => record('onError'));
		await wait(20);
		api.courses({ body: { x: 2 } }, result => record('onLoad 2', result), () => record('onError 2'));
		await wait(20);
	},

	// ------------------------------------------------------------ hooks
	async 'beforeSend on a GET'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		const api = make(Reste, base({
			beforeSend(data, callback) {
				record('beforeSend', data);
				callback(data);
			}
		}));
		api.getVideos(() => record('onLoad'));
		await wait(20);
	},
	async 'beforePost and beforeSend on a POST'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		const api = make(Reste, base({
			beforePost(params, callback) {
				record('beforePost');
				params.something = 'else';
				callback(params);
			},
			beforeSend(data, callback) {
				record('beforeSend');
				callback(data);
			}
		}));
		api.addVideo({ body: { a: 1 } }, () => record('onLoad'));
		await wait(20);
	},
	async 'beforeSend that skips the request'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		const api = make(Reste, base({ beforeSend: (data, callback) => callback({ skip: true, error: 'no_internet' }) }));
		api.getVideos({}, result => record('onLoad', result), () => record('onError'));
		await wait(20);
	},

	// ------------------------------------------------------------ headers
	async 'changeRequestHeader, removeRequestHeaderItem, setRequestHeaders'({ Reste, ti, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		const api = make(Reste, base());
		api.changeRequestHeader({ Authorization: 'Bearer 1' });
		api.getVideos(() => {});
		await wait(10);
		api.removeRequestHeaderItem('Content-Type');
		api.getVideos(() => {});
		await wait(10);
		api.setRequestHeaders({ A: () => 'from a function' });
		api.getVideos(() => {});
		await wait(10);
	},
	async 'headers of a method'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		const config = base();
		config.methods.push({ name: 'getAccounts', get: 'user/accounts', headers: { Authorization: () => 'Something' } });
		make(Reste, config).getAccounts(() => record('onLoad'));
		await wait(20);
	},

	// ------------------------------------------------------------ models and collections
	async 'a collection fetch'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: { results: [{ objectId: 'a', name: 'one' }, { objectId: 'b', name: 'two' }] } }));
		make(Reste, withModels());
		const collection = Alloy.Collections.locations;
		collection.fetch({ success: target => record('success', target.map(model => [model.id, model.get('id'), model.get('objectId'), model.get('name')])) });
		await wait(20);
		record('found by id', Boolean(collection.get('a')));
		record('transform', collection.at(0).transform());
		collection.fetch();
		await wait(20);
		record('length after a second fetch', collection.length);
	},
	async 'a collection fetch with a parameter'({ Reste, ti, wait }) {
		ti.respond(() => ({ status: 200, body: { results: [] } }));
		make(Reste, withModels());
		Alloy.Collections.locationsByName.fetch({ name: 'home' });
		await wait(20);
	},
	async 'a collection fetch that fails'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 500, body: { m: 'x' } }));
		make(Reste, withModels());
		Alloy.Collections.locations.fetch({ success: () => record('success'), error: (target, error) => record('error', errorFields(error)) });
		await wait(20);
	},
	async 'a collection without an id setting keeps the items\' ids'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: [{ id: 7, name: 'n' }] }));
		make(Reste, { url: 'https://api.test/', methods: [{ name: 'getX', get: 'x' }], models: [{ name: 'x', collections: [{ name: 'xs', read: 'getX' }] }] });
		Alloy.Collections.xs.fetch();
		await wait(20);
		record('ids', Alloy.Collections.xs.map(model => model.id));
	},
	async 'create and update a model'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 201, body: { objectId: 'n1', createdAt: 't' } }));
		const api = make(Reste, withModels());
		const model = api.createModel('location');
		model.save({ name: 'x' }, { success: () => record('created'), error: () => record('error') });
		await wait(20);
		record('after create', model.id, model.isNew());
		ti.respond(() => ({ status: 200, body: { updatedAt: 'u' } }));
		model.save({ name: 'y' }, { success: () => record('updated'), error: () => record('error 2') });
		await wait(20);
	},
	async 'destroy a model that was loaded'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: { results: [{ objectId: 'a', name: 'one' }] } }));
		make(Reste, withModels());
		const collection = Alloy.Collections.locations;
		collection.fetch();
		await wait(20);
		ti.respond(() => ({ status: 200, body: {} }));
		collection.at(0).destroy({ success: () => record('destroyed'), error: () => record('error') });
		await wait(20);
		record('left in the collection', collection.length);
	},
	async 'a model made with { id } is not new: save updates it'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: { objectId: 'a' } }));
		const model = make(Reste, withModels()).createModel('location', { id: 'a', name: 'x' });
		record('isNew', model.isNew(), model.id);
		model.save({ name: 'y' }, { success: () => record('saved'), error: () => record('error') });
		await wait(20);
	},
	async 'a model made with { id } can be destroyed'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: {} }));
		const model = make(Reste, withModels()).createModel('location', { id: 'a', name: 'x' });
		model.destroy({ success: () => record('destroyed'), error: () => record('error') });
		await wait(20);
	},
	async 'a model made with { id } can be fetched'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: { objectId: 'a', name: 'fetched' } }));
		const model = make(Reste, withModels()).createModel('location', { id: 'a' });
		model.fetch({ success: () => record('fetched', model.get('name')), error: () => record('error') });
		await wait(20);
	},
	async 'collection.get() by id after add({ id })'({ Reste, record }) {
		make(Reste, withModels());
		Alloy.Collections.locations.add({ id: 'z', name: 'pushed' });
		record('found', Boolean(Alloy.Collections.locations.get('z')));
	},
	async 'createModel for an unknown name'({ Reste, record }) {
		const model = make(Reste, withModels()).createModel('whatever', { a: 1 });
		record('model', model.transform(), model._type);
	},
	async 'createModel for a configured model'({ Reste, record }) {
		const model = make(Reste, withModels()).createModel('location', { name: 'q' });
		record('model', model.transform(), model._type, typeof model.save);
	},
	async 'createCollection'({ Reste, record }) {
		make(Reste, withModels()).createCollection('things', [{ a: 1 }, { a: 2 }]);
		const collection = Alloy.Collections.things;
		const events = [];
		collection.on('all', name => events.push(name));
		collection.fetch();
		record('collection', collection.length, events);
	},
	async 'a successful save whose body has a code field'({ Reste, ti, record, wait }) {
		ti.respond(() => ({ status: 200, body: { code: 404, message: 'a field named code', objectId: 'k' } }));
		const model = make(Reste, withModels()).createModel('location');
		model.save({ name: 'x' }, { success: () => record('saved'), error: () => record('error') });
		await wait(20);
	}
};
