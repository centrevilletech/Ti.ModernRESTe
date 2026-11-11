'use strict';

/**
 * Titanium's HTTP client API on top of Node's http module, for the integration tests: real sockets, real
 * timeouts, real multipart bodies, against test/server/server.js.
 *
 * Mirrors what Titanium does with what send() is given: a string goes out as is; an object with a Ti.Blob /
 * File value becomes multipart/form-data with a generated boundary; any other object is form-encoded.
 * onload fires for a status below 400, onerror for 400 and above and for every failure without a response.
 */
const http = require('http');
const crypto = require('crypto');

function isBinary(value) {
	return value && typeof value === 'object' && (value.apiName === 'Ti.Blob' || value.apiName === 'Ti.Filesystem.File');
}

function bufferOf(value) {
	if (value.apiName === 'Ti.Filesystem.File') {
		const blob = value.read();
		return blob ? blob.buffer : Buffer.alloc(0);
	}
	return value.buffer;
}

function encodeBody(body, headers) {
	if (body === undefined || body === null) {
		return null;
	}
	if (typeof body === 'string') {
		return Buffer.from(body, 'utf8');
	}
	const names = Object.keys(body);
	if (names.some(name => isBinary(body[name]))) {
		const boundary = '----ti' + crypto.randomBytes(12).toString('hex');
		const parts = [];
		names.forEach((name) => {
			const value = body[name];
			if (isBinary(value)) {
				parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"; filename="'
					+ (value.name || 'file') + '"\r\nContent-Type: ' + (value.mimeType || 'application/octet-stream') + '\r\n\r\n'));
				parts.push(bufferOf(value));
				parts.push(Buffer.from('\r\n'));
			} else {
				parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + String(value) + '\r\n'));
			}
		});
		parts.push(Buffer.from('--' + boundary + '--\r\n'));
		headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary;
		return Buffer.concat(parts);
	}
	if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) {
		headers['Content-Type'] = 'application/x-www-form-urlencoded';
	}
	return Buffer.from(names.map(name => encodeURIComponent(name) + '=' + encodeURIComponent(body[name])).join('&'), 'utf8');
}

function createNodeHttpClient(creation) {
	const options = creation || {};
	let request = null;
	let method = 'GET';
	let url = '';
	const headers = {};
	let done = false;

	const client = {
		apiName: 'Ti.Network.HTTPClient',
		creation: options,
		timeout: options.timeout,
		status: 0,
		responseText: null,
		responseData: null,
		responseHeaders: {},
		onload: null,
		onerror: null,
		onsendstream: null,
		ondatastream: null,
		file: null,
		open(verb, target) {
			method = verb;
			url = target;
		},
		setRequestHeader(name, value) {
			headers[name] = String(value);
		},
		getResponseHeader(name) {
			const value = client.responseHeaders[String(name).toLowerCase()];
			return value === undefined ? null : value;
		},
		abort() {
			done = true;
			if (request) {
				request.destroy();
			}
		},
		clearCookies() {},
		send(body) {
			const payload = encodeBody(body, headers);
			if (payload) {
				headers['Content-Length'] = payload.length;
			}
			request = http.request(url, { method, headers, agent: false }, (response) => {
				const chunks = [];
				const total = Number(response.headers['content-length']) || 0;
				let received = 0;
				response.on('data', (chunk) => {
					chunks.push(chunk);
					received += chunk.length;
					if (!done && client.ondatastream) {
						client.ondatastream({ progress: total ? received / total : -1 });
					}
				});
				response.on('error', error => fail(error.message));
				response.on('aborted', () => fail('connection reset while reading the response'));
				response.on('end', () => {
					if (done) {
						return;
					}
					done = true;
					const buffer = Buffer.concat(chunks);
					client.status = response.statusCode;
					client.responseHeaders = response.headers;
					client.responseText = buffer.toString('utf8');
					client.responseData = { apiName: 'Ti.Blob', buffer, length: buffer.length, mimeType: response.headers['content-type'] || null };
					if (client.file && client.status < 400) {
						client.file.write(buffer);
					}
					if (client.status >= 400) {
						if (client.onerror) {
							client.onerror({ success: false, code: client.status, error: 'HTTP error', source: client, type: 'error' });
						}
					} else if (client.onload) {
						client.onload({ success: true, code: 0, source: client, type: 'load' });
					}
				});
			});
			function fail(message, code) {
				if (done) {
					return;
				}
				done = true;
				client.status = 0;
				request.destroy();
				if (client.onerror) {
					client.onerror({ success: false, code: code === undefined ? -1 : code, error: message, source: client, type: 'error' });
				}
			}
			if (client.timeout > 0) {
				request.setTimeout(client.timeout, () => fail('The request timed out.', -1001));
			}
			request.on('error', error => fail(error.message || String(error)));
			if (!payload) {
				request.end();
				return;
			}
			// Written in pieces so progress is real.
			const piece = Math.max(1024, Math.ceil(payload.length / 10));
			let offset = 0;
			const writeNext = () => {
				if (done) {
					return;
				}
				const end = Math.min(offset + piece, payload.length);
				request.write(payload.slice(offset, end), () => {
					offset = end;
					if (!done && client.onsendstream) {
						client.onsendstream({ progress: offset / payload.length });
					}
					if (offset < payload.length) {
						setImmediate(writeNext);
					} else {
						request.end();
					}
				});
			};
			writeNext();
		}
	};
	return client;
}

module.exports = { createNodeHttpClient };
