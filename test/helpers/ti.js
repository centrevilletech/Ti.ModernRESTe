'use strict';

/**
 * A scripted stand-in for Titanium's HTTP client and the few other Ti APIs RESTe touches.
 *
 *   const ti = installFakeTi();
 *   ti.respond((request) => ({ status: 200, body: { ok: true } }));   // answer every request
 *   ti.requests                                                        // everything sent, in order
 *   ti.requests[0].respond({ status: 500 }) / .fail({ error: 'x' })    // answer by hand when no responder did
 *
 * A responder may return nothing to leave the request pending.
 */

class FakeBlob {
	constructor(content, mimeType, name) {
		this.apiName = 'Ti.Blob';
		this.buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
		this.mimeType = mimeType || 'application/octet-stream';
		this.name = name || 'blob.bin';
		this.length = this.buffer.length;
	}

	get text() {
		return this.buffer.toString('utf8');
	}
}

class FakeFile {
	constructor(path, files) {
		this.apiName = 'Ti.Filesystem.File';
		this.nativePath = path;
		this.files = files;
	}

	get name() {
		return this.nativePath.split('/').pop();
	}

	exists() {
		return this.files.has(this.nativePath);
	}

	createDirectory() {
		this.files.set(this.nativePath, { directory: true });
		return true;
	}

	write(content) {
		// A string, a Node Buffer, or a blob (whose bytes are in .buffer).
		const bytes = typeof content === 'string' || Buffer.isBuffer(content) ? content : content.buffer || content;
		this.files.set(this.nativePath, { content: bytes });
		return true;
	}

	read() {
		const entry = this.files.get(this.nativePath);
		return entry ? new FakeBlob(entry.content) : null;
	}

	deleteFile() {
		return this.files.delete(this.nativePath);
	}

	getDirectoryListing() {
		const prefix = this.nativePath.replace(/\/$/, '') + '/';
		return Array.from(this.files.keys()).filter(path => path.indexOf(prefix) === 0).map(path => path.slice(prefix.length));
	}
}

function installFakeTi(options) {
	const settings = options || {};
	const requests = [];
	const clients = [];
	const properties = new Map();
	const files = new Map();
	let responder = null;
	let uuidCounter = 0;

	function createHTTPClient(creation) {
		const client = {
			apiName: 'Ti.Network.HTTPClient',
			creation: creation || {},
			timeout: creation && creation.timeout,
			status: 0,
			statusText: '',
			responseText: null,
			responseData: null,
			responseHeaders: {},
			onload: null,
			onerror: null,
			onsendstream: null,
			ondatastream: null,
			file: null,
			aborted: false,
			cookiesCleared: null,
			request: null,
			open(method, url) {
				client.request = {
					method, url, headers: {}, body: undefined, client, settled: false, aborted: false,
					timeout: client.timeout,
					respond: answer => deliver(client, answer || {}),
					fail: event => failNow(client, event || {}),
					progress(fraction) {
						if (client.onsendstream) {
							client.onsendstream({ progress: fraction });
						}
					},
					downloadProgress(fraction) {
						if (client.ondatastream) {
							client.ondatastream({ progress: fraction });
						}
					}
				};
			},
			setRequestHeader(name, value) {
				client.request.headers[name] = value;
			},
			send(body) {
				const request = client.request;
				request.body = body;
				request.json = undefined;
				if (typeof body === 'string') {
					try {
						request.json = JSON.parse(body);
					} catch (error) {
						request.json = undefined;
					}
				}
				requests.push(request);
				if (responder) {
					const answer = responder(request);
					if (answer) {
						if (settings.sync || answer.sync) {
							deliver(client, answer);
						} else {
							setTimeout(() => deliver(client, answer), answer.delay || 0);
						}
					}
				}
			},
			abort() {
				client.aborted = true;
				if (client.request) {
					client.request.aborted = true;
					client.request.settled = true;
				}
			},
			getResponseHeader(name) {
				const wanted = String(name).toLowerCase();
				const key = Object.keys(client.responseHeaders).find(header => header.toLowerCase() === wanted);
				return key ? client.responseHeaders[key] : null;
			},
			clearCookies(url) {
				client.cookiesCleared = url;
			}
		};
		clients.push(client);
		return client;
	}

	function deliver(client, answer) {
		const request = client.request;
		if (request.settled) {
			return;
		}
		if (answer.error || answer.status === 0) {
			failNow(client, { error: answer.error || 'connection failed', code: answer.code });
			return;
		}
		request.settled = true;
		client.status = answer.status === undefined ? 200 : answer.status;
		client.responseHeaders = Object.assign({}, answer.headers);
		if (answer.text !== undefined) {
			client.responseText = answer.text;
		} else if (answer.body !== undefined) {
			client.responseText = JSON.stringify(answer.body);
			if (!Object.keys(client.responseHeaders).some(name => name.toLowerCase() === 'content-type')) {
				client.responseHeaders['Content-Type'] = 'application/json';
			}
		} else {
			client.responseText = '';
		}
		client.responseData = answer.data !== undefined ? answer.data : new FakeBlob(client.responseText || '');
		if (client.file && client.responseText != null) {
			client.file.write(client.responseText);
		}
		if (client.status >= 400) {
			if (client.onerror) {
				client.onerror({ success: false, code: client.status, error: 'HTTP error', source: client, type: 'error' });
			}
		} else if (client.onload) {
			client.onload({ success: true, code: 0, source: client, type: 'load' });
		}
	}

	function failNow(client, event) {
		const request = client.request;
		if (request.settled) {
			return;
		}
		request.settled = true;
		client.status = 0;
		client.responseText = null;
		if (client.onerror) {
			client.onerror(Object.assign({ success: false, code: -1, error: 'connection failed', source: client, type: 'error' }, event));
		}
	}

	const Ti = {
		Network: {
			online: true,
			createHTTPClient
		},
		Platform: {
			createUUID: () => 'UUID-' + String(++uuidCounter).padStart(4, '0')
		},
		App: {
			Properties: {
				getString: (key, fallback) => (properties.has(key) ? properties.get(key) : fallback),
				setString: (key, value) => properties.set(key, value),
				removeProperty: key => properties.delete(key),
				listProperties: () => Array.from(properties.keys())
			}
		},
		Filesystem: {
			applicationCacheDirectory: '/cache/',
			getFile() {
				const path = Array.prototype.slice.call(arguments).join('/').replace(/\/{2,}/g, '/');
				return new FakeFile(path, files);
			}
		},
		API: { info() {}, warn() {}, error() {}, debug() {} }
	};

	global.Ti = Ti;

	return {
		Ti,
		requests,
		clients,
		properties,
		files,
		/** Sets the function that answers requests; returns nothing to leave a request pending. */
		respond(fn) {
			responder = typeof fn === 'function' ? fn : () => fn;
		},
		get last() {
			return requests[requests.length - 1];
		},
		reset() {
			requests.length = 0;
			clients.length = 0;
			responder = null;
		},
		uninstall() {
			delete global.Ti;
		},
		createBlob: (content, mimeType, name) => new FakeBlob(content, mimeType, name)
	};
}

/** Resolves on a later turn of the event loop (after `ms`, 0 by default). */
function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms || 0));
}

/** Resolves once `predicate()` is true, checking every few milliseconds. */
async function until(predicate, timeout) {
	const deadline = Date.now() + (timeout || 2000);
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error('timed out waiting for ' + predicate);
		}
		await wait(2);
	}
}

module.exports = { installFakeTi, FakeBlob, FakeFile, wait, until };
