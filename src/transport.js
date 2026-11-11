'use strict';

const { isObject, lowerKeys, now } = require('./util');

/** HTTP client creation properties RESTe passes through untouched when they are configured. */
const CLIENT_OPTIONS = [
	'autoEncodeUrl', 'autoRedirect', 'cache', 'domain', 'enableKeepAlive', 'password', 'tlsVersion', 'username',
	'withCredentials'
];

function defaultFactory(options) {
	return Ti.Network.createHTTPClient(options);
}

/**
 * One HTTP exchange on Titanium's HTTP client.
 *
 * request: { method, url, headers, payload, timeout, file, clientOptions, securityManager,
 *            validatesSecureCertificate, onUploadProgress, onDownloadProgress }
 * done({ status, http, event, elapsed }) is called exactly once, and never after abort().
 *
 * @returns {{abort: function(): void, http: object}}
 */
function send(factory, request, done) {
	const options = { timeout: request.timeout };
	if (request.securityManager) {
		// Creation-only on Android, so it has to be part of the creation dictionary.
		options.securityManager = request.securityManager;
	}
	if (request.validatesSecureCertificate !== undefined) {
		options.validatesSecureCertificate = request.validatesSecureCertificate;
	}
	const extra = request.clientOptions;
	if (extra) {
		for (let i = 0; i < CLIENT_OPTIONS.length; i++) {
			if (extra[CLIENT_OPTIONS[i]] !== undefined) {
				options[CLIENT_OPTIONS[i]] = extra[CLIENT_OPTIONS[i]];
			}
		}
	}

	const http = (factory || defaultFactory)(options);
	const started = now();
	let finished = false;

	function finish(event) {
		if (finished) {
			return;
		}
		finished = true;
		let status = 0;
		try {
			status = http.status || 0;
		} catch (error) {
			status = 0;
		}
		done({ status, http, event: event || null, elapsed: now() - started });
	}

	http.onload = finish;
	http.onerror = finish;
	if (request.onUploadProgress) {
		http.onsendstream = stepped(request.onUploadProgress, request.progressStep, () => finished);
	}
	if (request.onDownloadProgress) {
		http.ondatastream = stepped(request.onDownloadProgress, request.progressStep, () => finished);
	}

	http.open(request.method, request.url);

	const headers = request.headers;
	const names = Object.keys(headers);
	for (let i = 0; i < names.length; i++) {
		http.setRequestHeader(names[i], headers[names[i]]);
	}
	if (request.file) {
		http.file = request.file;
	}

	if (request.payload === undefined) {
		http.send();
	} else {
		http.send(request.payload);
	}

	return {
		http,
		abort() {
			if (finished) {
				return;
			}
			finished = true;
			try {
				http.abort();
			} catch (error) {
				// Aborting a client that never connected throws on some platforms; the request is over anyway.
			}
		}
	};
}

/**
 * A progress listener that calls `report` only when progress moved by at least `step` (1 % by default), and
 * always for the end. Titanium's Android client reports every few hundred bytes: thousands of events for one
 * photo, each of which would otherwise reach the app's UI code.
 */
function stepped(report, step, isFinished) {
	const least = step === undefined || step === null ? 0.01 : step;
	let last = -1;
	return function (event) {
		if (isFinished()) {
			return;
		}
		const value = clamp(event && event.progress);
		if (value === last || (value < 1 && last >= 0 && value - last < least && value >= last)) {
			return;
		}
		last = value;
		report(value);
	};
}

function clamp(progress) {
	const value = Number(progress);
	if (!(value > 0)) {
		return 0; // Titanium reports -1 while the total size is unknown
	}
	return value > 1 ? 1 : value;
}

/** Every response header with a lower-cased name, from whichever accessor the platform offers. */
function readHeaders(http) {
	let source = null;
	try {
		source = http.responseHeaders;
	} catch (error) {
		source = null;
	}
	if (isObject(source)) {
		return lowerKeys(source);
	}
	let raw = null;
	try {
		raw = typeof http.getAllResponseHeaders === 'function' ? http.getAllResponseHeaders() : http.allResponseHeaders;
	} catch (error) {
		raw = null;
	}
	const out = {};
	if (typeof raw === 'string') {
		raw.split(/\r?\n/).forEach((line) => {
			const colon = line.indexOf(':');
			if (colon > 0) {
				out[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
			}
		});
	}
	return out;
}

/** One response header, without reading them all. */
function readHeader(http, name) {
	try {
		const value = http.getResponseHeader(name);
		if (value != null) {
			return value;
		}
		return http.getResponseHeader(name.toLowerCase());
	} catch (error) {
		return null;
	}
}

function readText(http) {
	try {
		const text = http.responseText;
		return text == null ? '' : text;
	} catch (error) {
		return '';
	}
}

module.exports = { send, readHeaders, readHeader, readText, stepped, CLIENT_OPTIONS };
