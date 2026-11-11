'use strict';

const { isFunction, isObject, isBinary } = require('./util');

const REDACTED = '[redacted]';

const DEFAULT_REDACTED_HEADERS = [
	'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'x-csrf-token',
	'x-xsrf-token'
];

const DEFAULT_REDACTED_KEYS = [
	'password', 'password_confirmation', 'current_password', 'new_password', 'token', 'access_token',
	'refresh_token', 'id_token', 'secret', 'client_secret', 'api_key', 'apikey', 'authorization', 'otp', 'card_number',
	'cvc', 'cvv'
];

function toSet(defaults, extra) {
	const set = Object.create(null);
	defaults.concat(extra || []).forEach((name) => {
		set[String(name).toLowerCase()] = true;
	});
	return set;
}

/**
 * The debug logger. Off unless `config.debug` is set, and then it never prints a credential: header values
 * named in `redact.headers` (Authorization, cookies and API keys by default) and body or query values whose
 * key is in `redact.keys` (passwords, tokens, codes by default) are replaced by "[redacted]".
 *
 * `config.logger(level, message, details)` replaces console output; `debug: 'verbose'` adds headers and bodies.
 */
function createLogger(config) {
	const enabled = Boolean(config.debug);
	const verbose = config.debug === 'verbose';
	const sink = isFunction(config.logger) ? config.logger : null;
	const redact = config.redact || {};
	const headerNames = toSet(DEFAULT_REDACTED_HEADERS, redact.headers);
	const keyNames = toSet(DEFAULT_REDACTED_KEYS, redact.keys);

	function redactHeaders(headers) {
		const out = {};
		if (headers) {
			const keys = Object.keys(headers);
			for (let i = 0; i < keys.length; i++) {
				out[keys[i]] = headerNames[keys[i].toLowerCase()] ? REDACTED : headers[keys[i]];
			}
		}
		return out;
	}

	function redactValue(value, depth) {
		if (isBinary(value)) {
			return '[binary]';
		}
		if (!isObject(value) || depth > 6) {
			return value;
		}
		if (Array.isArray(value)) {
			return value.map(item => redactValue(item, depth + 1));
		}
		const out = {};
		const keys = Object.keys(value);
		for (let i = 0; i < keys.length; i++) {
			out[keys[i]] = keyNames[keys[i].toLowerCase()] ? REDACTED : redactValue(value[keys[i]], depth + 1);
		}
		return out;
	}

	/** Replaces the values of sensitive query parameters in a URL. */
	function redactUrl(url) {
		const mark = url.indexOf('?');
		if (mark === -1) {
			return url;
		}
		const pairs = url.slice(mark + 1).split('&').map((pair) => {
			const equals = pair.indexOf('=');
			if (equals === -1) {
				return pair;
			}
			let key = pair.slice(0, equals);
			try {
				key = decodeURIComponent(key);
			} catch (error) {
				// Keep the raw key.
			}
			return keyNames[key.replace(/\[.*$/, '').toLowerCase()] ? pair.slice(0, equals + 1) + REDACTED : pair;
		});
		return url.slice(0, mark + 1) + pairs.join('&');
	}

	function write(level, message, details) {
		if (sink) {
			sink(level, message, details);
			return;
		}
		const line = '::RESTE::' + message + (details === undefined ? '' : ' ' + safeStringify(details));
		if (level === 'warn' || level === 'error') {
			console.warn(line);
		} else {
			console.log(line);
		}
	}

	return {
		enabled,
		verbose,
		redactHeaders,
		redactUrl,
		redactBody: value => redactValue(value, 0),
		log(message, details) {
			if (enabled) {
				write('info', message, details);
			}
		},
		warn(message, details) {
			if (enabled) {
				write('warn', message, details);
			}
		},
		/** Printed even with debug off: something the developer has to know about. */
		always(message, details) {
			write('warn', message, details);
		}
	};
}

function safeStringify(value) {
	try {
		return typeof value === 'string' ? value : JSON.stringify(value);
	} catch (error) {
		return String(value);
	}
}

module.exports = { createLogger, REDACTED };
