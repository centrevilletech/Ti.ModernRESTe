'use strict';

/* What the debug log may print. */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setup } = require('../helpers/setup');

let ti;
afterEach(() => ti && ti.uninstall());

function make(config) {
	const lines = [];
	const made = setup(Object.assign({ logger: (level, message, details) => lines.push(message + ' ' + JSON.stringify(details === undefined ? '' : details)) }, config));
	ti = made.ti;
	ti.respond(() => ({ status: 200, body: { ok: true }, headers: { 'Set-Cookie': 'session=SECRET-COOKIE' } }));
	return { api: made.api, lines, text: () => lines.join('\n') };
}

function leaked(text) {
	const found = new Set();
	text.replace(/SECRET[\w-]*/g, secret => found.add(secret));
	return Array.from(found);
}

describe('the debug log and credentials', () => {
	it('redacts headers whose name looks like a credential, however it is written', async () => {
		const { api, text } = make({
			debug: 'verbose',
			requestHeaders: {
				Authorization: 'Bearer SECRET-1', 'X-Access-Token': 'SECRET-2', 'X-Amz-Security-Token': 'SECRET-3', Cookie: 'sid=SECRET-4',
				'x-api-key': 'SECRET-5', 'X-Csrf-Token': 'SECRET-6', 'Proxy-Authorization': 'SECRET-7', 'X-Client-Secret': 'SECRET-8', Accept: 'application/json'
			},
			methods: [{ name: 'get', get: 'things' }]
		});
		await api.get();
		assert.deepEqual(leaked(text()), []);
		assert.match(text(), /application\/json/);
	});

	it('redacts body fields in snake_case, camelCase and nested, and keeps the rest readable', async () => {
		const { api, text } = make({ debug: 'verbose', methods: [{ name: 'login', post: 'auth/login' }] });
		await api.login({
			body: {
				email: 'a@b.c', password: 'SECRET-1', accessToken: 'SECRET-2', refreshToken: 'SECRET-3', newPassword: 'SECRET-4', refresh_token: 'SECRET-5',
				client_secret: 'SECRET-6', apiKey: 'SECRET-7', pin: 'SECRET-8', card: { cvv: 'SECRET-9', number: '4111' }, list: [{ privateKey: 'SECRET-10' }],
				keyword: 'visible', author: 'also visible'
			}
		});
		assert.deepEqual(leaked(text()), []);
		assert.match(text(), /a@b\.c/);
		assert.match(text(), /visible/);
		assert.match(text(), /also visible/);
	});

	it('redacts string bodies: JSON text, form text, and anything it cannot read', async () => {
		const { api, text } = make({ debug: 'verbose', methods: [{ name: 'post', post: 'things' }, { name: 'form', post: 'form', form: true }] });
		await api.post({ body: JSON.stringify({ refresh_token: 'SECRET-1', page: 2 }) });
		await api.form({ body: 'password=SECRET-2&user=someone' });
		await api.form({ body: { password: 'SECRET-3', user: { token: 'SECRET-4' }, plain: 'shown' } });
		await api.post({ body: '<xml><password>SECRET-5</password></xml>' });
		assert.deepEqual(leaked(text()), []);
		assert.match(text(), /page\\?":2/);
		assert.match(text(), /user=someone/);
		assert.match(text(), /shown/);
	});

	it('redacts query values, also with plain debug, where only the URL is printed', async () => {
		const { api, text } = make({
			debug: true,
			methods: [
				{ name: 'search', get: 'search' },
				{ name: 'upload', put: 'https://bucket.example/k?X-Amz-Credential=SECRET-1&X-Amz-Signature=SECRET-2&X-Amz-Security-Token=SECRET-3&X-Amz-Date=20260101' },
				{ name: 'maps', get: 'https://maps.example/geocode?address=somewhere&key=SECRET-4' }
			]
		});
		await api.search({ query: { access_token: 'SECRET-5', accessToken: 'SECRET-6', sig: 'SECRET-7', page: 2 } });
		await api.upload({ body: 'x' });
		await api.maps();
		assert.deepEqual(leaked(text()), []);
		assert.match(text(), /page=2/);
		assert.match(text(), /address=somewhere/);
		assert.match(text(), /X-Amz-Date=20260101/);
	});

	it('redacts path values whose placeholder is named like a credential, or that the method names', async () => {
		const { api, text } = make({
			debug: true,
			methods: [
				{ name: 'verify', get: 'auth/verify/<token>' },
				{ name: 'reset', get: 'auth/reset/<code>/<user>', redact: ['code'] },
				{ name: 'plain', get: 'things/<id>' }
			]
		});
		await api.verify({ token: 'SECRET-1' });
		await api.reset({ code: 'SECRET-2', user: 'visible-user' });
		await api.plain({ id: 'visible-id' });
		assert.deepEqual(leaked(text()), []);
		assert.match(text(), /visible-user/);
		assert.match(text(), /visible-id/);
		assert.equal(ti.requests[0].url, 'https://api.test/v1/auth/verify/SECRET-1'); // only the log is changed
	});

	it('takes more names from the config, and a function for anything else', async () => {
		const { api, text } = make({
			debug: 'verbose',
			redact: { headers: ['X-Tenant'], keys: ['iban'], url: url => url.replace(/\/devices\/[^/?]+/, '/devices/[redacted]') },
			requestHeaders: { 'X-Tenant': 'SECRET-1' },
			methods: [{ name: 'device', post: 'devices/<pushId>' }]
		});
		await api.device({ pushId: 'SECRET-2', body: { iban: 'SECRET-3', IBAN_backup: 'SECRET-4' } });
		assert.deepEqual(leaked(text()), []);
	});

	it('lets a name that only looks like a credential be shown: redact.allow', async () => {
		const { api, text } = make({
			debug: 'verbose', redact: { allow: ['session_token', 'X-Request-Key'] },
			requestHeaders: { 'X-Request-Key': 'visible-header', Authorization: 'Bearer SECRET-1' },
			methods: [{ name: 'search', post: 'search' }]
		});
		await api.search({ query: { session_token: 'visible-query', access_token: 'SECRET-2' }, body: { session_token: 'visible-body', token: 'SECRET-3' } });
		assert.deepEqual(leaked(text()), []);
		assert.match(text(), /session_token=visible-query/);
		assert.match(text(), /visible-body/);
		assert.match(text(), /visible-header/);
	});

	it('does not print response headers or bodies', async () => {
		const { api, text } = make({ debug: 'verbose', methods: [{ name: 'get', get: 'things' }] });
		await api.get();
		assert.deepEqual(leaked(text()), []);
	});
});
