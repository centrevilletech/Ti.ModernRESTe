'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup, rejection, wait } = require('../helpers/setup');

let ti;
afterEach(() => ti && ti.uninstall());

function make(config) {
	const made = setup(Object.assign({
		requestHeaders: { 'Content-Type': 'application/json', Authorization: 'Bearer t' },
		methods: [
			{ name: 'upload', post: 'photos', multipart: true, idempotent: true },
			{ name: 'auto', post: 'auto' },
			{ name: 'download', get: 'files/<id>', download: true },
			{ name: 'blob', get: 'blob', responseType: 'blob' }
		]
	}, config));
	ti = made.ti;
	return made;
}

describe('uploads', () => {
	it('send files and fields as one flat multipart dictionary, without a Content-Type of their own', async () => {
		const { api } = make();
		ti.respond(() => ({ status: 201, body: { id: 9 } }));
		const photo = ti.createBlob('JPEGDATA', 'image/jpeg', 'a.jpg');
		const doc = ti.Ti.Filesystem.getFile('/tmp/doc.pdf');
		const result = await api.upload({ body: { photo, 'documents[]': [doc, doc], caption: 'Front', tags: ['a', 'b'], meta: { private: true }, skip: null } });
		assert.deepEqual(result, { id: 9 });
		assert.deepEqual(Object.keys(ti.last.body), ['photo', 'documents[0]', 'documents[1]', 'caption', 'tags[0]', 'tags[1]', 'meta[private]']);
		assert.equal(ti.last.body.photo, photo);
		assert.equal(ti.last.body['documents[1]'], doc);
		assert.equal(ti.last.body['meta[private]'], 'true');
		// Titanium writes the boundary; the JSON content type from the defaults must not go out.
		assert.equal(ti.last.headers['Content-Type'], undefined);
		assert.equal(ti.last.headers.Authorization, 'Bearer t');
	});

	it('switch to multipart on their own when the body holds a blob', async () => {
		const { api } = make();
		ti.respond(() => ({ status: 201, body: {} }));
		await api.auto({ body: { avatar: ti.createBlob('x'), name: 'n' } });
		assert.equal(typeof ti.last.body, 'object');
		assert.equal(ti.last.headers['Content-Type'], undefined);
		await api.auto({ body: { name: 'n' } });
		assert.equal(ti.last.body, '{"name":"n"}');
	});

	it('report progress and go through the same error, header and idempotency pipeline', async () => {
		const { api } = make({ mapError: error => ({ mapped: error.status, key: error.idempotencyKey }) });
		ti.respond(() => null);
		const progress = [];
		const handle = api.upload({ body: { photo: ti.createBlob('x') } }, { onProgress: value => progress.push(value) });
		ti.last.progress(-1); // Titanium reports -1 until it knows the size
		ti.last.progress(0.25);
		ti.last.progress(1.2);
		assert.deepEqual(progress, [0, 0.25, 1]);
		assert.ok(ti.last.headers['Idempotency-Key']);
		ti.last.respond({ status: 413, body: { code: 'TOO_LARGE' } });
		assert.deepEqual(await rejection(handle), { mapped: 413, key: handle.idempotencyKey });
	});

	it('report progress in steps: thousands of platform events become at most a hundred calls', async () => {
		const { api } = make();
		ti.respond(() => null);
		const progress = [];
		const handle = api.upload({ body: { photo: ti.createBlob('x') } }, { onProgress: value => progress.push(value) });
		for (let i = 0; i <= 6000; i++) {
			ti.last.progress(i / 6000); // what Titanium's Android client does for a 3 MB upload
		}
		assert.ok(progress.length <= 101, progress.length + ' calls');
		assert.equal(progress[0], 0);
		assert.equal(progress[progress.length - 1], 1);
		handle.abort();
		await rejection(handle);
		const every = [];
		const fine = api.upload({ body: { photo: ti.createBlob('x') } }, { onProgress: value => every.push(value), progressStep: 0 });
		[0.001, 0.002, 0.003].forEach(value => ti.last.progress(value));
		assert.deepEqual(every, [0.001, 0.002, 0.003]);
		fine.abort();
		await rejection(fine);
	});

	it('can be cancelled, and report no progress afterwards', async () => {
		const { api } = make();
		ti.respond(() => null);
		const progress = [];
		const handle = api.upload({ body: { photo: ti.createBlob('x') } }, { onProgress: value => progress.push(value) });
		ti.last.progress(0.5);
		handle.abort();
		ti.last.progress(0.9);
		assert.equal(ti.last.aborted, true);
		assert.equal((await rejection(handle)).kind, 'cancelled');
		assert.deepEqual(progress, [0.5]);
	});

	it('are not retried unless they carry an idempotency key', async () => {
		const { api } = make({ retry: { retries: 1, baseDelay: 1, jitter: 0 } });
		let n = 0;
		ti.respond(() => (n++ ? { status: 201, body: {} } : { error: 'reset' }));
		assert.equal((await rejection(api.auto({ body: { f: ti.createBlob('x') } }))).kind, 'network');
		n = 0;
		await api.upload({ body: { f: ti.createBlob('x') } });
		const sent = ti.requests.slice(-2);
		assert.equal(sent[0].headers['Idempotency-Key'], sent[1].headers['Idempotency-Key']);
	});
});

describe('downloads', () => {
	it('write to a file, report progress and resolve with the file', async () => {
		const { api } = make();
		ti.respond(() => null);
		const file = ti.Ti.Filesystem.getFile('/cache/report.pdf');
		const progress = [];
		const handle = api.download({ id: 7 }, { file, onProgress: value => progress.push(value), fullResponse: true });
		assert.equal(ti.clients[0].file, file);
		ti.last.downloadProgress(0.5);
		ti.last.downloadProgress(1);
		ti.last.respond({ status: 200, text: 'PDFDATA', headers: { 'Content-Type': 'application/pdf' } });
		const response = await handle;
		assert.equal(response.file, file);
		assert.equal(response.data, file);
		assert.equal(file.read().text, 'PDFDATA');
		assert.deepEqual(progress, [0.5, 1]);
	});

	it('accept a path instead of a file', async () => {
		const { api } = make();
		ti.respond(() => ({ status: 200, text: 'DATA' }));
		const file = await api.download({ id: 1 }, { file: '/cache/by-path.bin' });
		assert.equal(file.nativePath, '/cache/by-path.bin');
		assert.equal(file.read().text, 'DATA');
	});

	it('resolve with the response blob when no file is given, or for responseType blob', async () => {
		const { api } = make();
		ti.respond(() => ({ status: 200, text: 'BYTES' }));
		assert.equal((await api.download({ id: 1 })).text, 'BYTES');
		assert.equal((await api.blob()).text, 'BYTES');
	});

	it('fail like any other request', async () => {
		const { api } = make();
		ti.respond(() => ({ status: 404, body: { code: 'NOT_FOUND' } }));
		const error = await rejection(api.download({ id: 1 }, { file: '/cache/x' }));
		assert.equal(error.status, 404);
		assert.deepEqual(error.body, { code: 'NOT_FOUND' });
		await wait();
	});
});
