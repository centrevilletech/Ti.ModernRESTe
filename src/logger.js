'use strict';

const { isFunction, isObject, isBinary } = require('./util');

const REDACTED = '[redacted]';

/**
 * A name is treated as a credential when, written without case and punctuation, it contains one of these...
 * (`X-Access-Token`, `accessToken`, `access_token`, `refreshToken`, `X-Amz-Signature`, `client_secret`)
 */
const SENSITIVE_PARTS = ['token', 'secret', 'password', 'passwd', 'passphrase', 'signature', 'credential', 'authorization',
	'cookie', 'apikey', 'privatekey', 'sessionid', 'otp', 'cvv', 'cvc', 'cardnumber'];

/** ... or is one of these, or ends in "key" (`key`, `api_key`, `X-Api-Key`; not `keyword`). */
const SENSITIVE_NAMES = ['key', 'sig', 'pin', 'pwd', 'auth', 'jwt', 'sid', 'ssn', 'code'];

function normalize(name) {
	return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The debug logger. Off unless `config.debug` is set, and then it replaces by "[redacted]" every value whose
 * *name* looks like a credential: request headers, fields of JSON and form bodies (also when the body is a
 * string), query parameters, and path values whose placeholder is named like one or that the method lists in
 * `redact`. `config.redact` adds names ({ headers, keys }) and a function for the URL ({ url }).
 *
 * It cannot recognise a secret under an innocent name, in free text, or in a path segment it was not told
 * about. Response headers and bodies are never printed.
 *
 * `config.logger(level, message, details)` replaces console output; `debug: 'verbose'` adds headers and bodies.
 * For the lines about a request `details` holds the facts: { event: 'request' | 'retry' | 'response' | 'error',
 * endpoint, method, url (as printed), attempt, status, kind, elapsed, duration, delay, fromCache }.
 */
function createLogger(config) {
	const enabled = Boolean(config.debug);
	const verbose = config.debug === 'verbose';
	const sink = isFunction(config.logger) ? config.logger : null;
	const redact = config.redact || {};
	const extra = [].concat(redact.headers || [], redact.keys || []).map(normalize).filter(Boolean);
	const urlHook = isFunction(redact.url) ? redact.url : null;

	function sensitive(name) {
		const plain = normalize(name);
		if (!plain) {
			return false;
		}
		if (SENSITIVE_NAMES.indexOf(plain) !== -1 || (plain.length > 3 && plain.slice(-3) === 'key')) {
			return true;
		}
		for (let i = 0; i < SENSITIVE_PARTS.length; i++) {
			if (plain.indexOf(SENSITIVE_PARTS[i]) !== -1) {
				return true;
			}
		}
		for (let i = 0; i < extra.length; i++) {
			if (plain.indexOf(extra[i]) !== -1) {
				return true;
			}
		}
		return false;
	}

	function redactHeaders(headers) {
		const out = {};
		if (headers) {
			const keys = Object.keys(headers);
			for (let i = 0; i < keys.length; i++) {
				out[keys[i]] = sensitive(keys[i]) ? REDACTED : headers[keys[i]];
			}
		}
		return out;
	}

	function redactValue(value, depth) {
		if (isBinary(value)) {
			return '[binary]';
		}
		if (!isObject(value) || depth > 8) {
			return value;
		}
		if (Array.isArray(value)) {
			return value.map(item => redactValue(item, depth + 1));
		}
		const out = {};
		const keys = Object.keys(value);
		for (let i = 0; i < keys.length; i++) {
			out[keys[i]] = sensitive(keys[i]) ? REDACTED : redactValue(value[keys[i]], depth + 1);
		}
		return out;
	}

	/** `a=1&password=x` with the values of sensitive names replaced. Names like `user[token]` count as `token`. */
	function redactPairs(text) {
		return text.split('&').map((pair) => {
			const equals = pair.indexOf('=');
			if (equals === -1) {
				return pair;
			}
			let name = pair.slice(0, equals);
			try {
				name = decodeURIComponent(name.replace(/\+/g, ' '));
			} catch (error) {
				// Keep the raw name.
			}
			const parts = name.split(/[[\]]+/).filter(Boolean);
			return parts.some(sensitive) ? pair.slice(0, equals + 1) + REDACTED : pair;
		}).join('&');
	}

	/** A body as it may be printed. Strings are read as JSON or as a form; anything else is not printed. */
	function redactBody(body) {
		if (typeof body !== 'string') {
			return redactValue(body, 0);
		}
		const text = body.trim();
		if (text.charAt(0) === '{' || text.charAt(0) === '[') {
			try {
				return JSON.stringify(redactValue(JSON.parse(text), 0));
			} catch (error) {
				// Not JSON after all.
			}
		}
		if (/^[^=&\s<>{}]+=[^&\s]*(&[^=&\s<>{}]+=[^&\s]*)*$/.test(text)) {
			return redactPairs(text);
		}
		return '[text, ' + body.length + ' characters]';
	}

	/** Replaces the values of sensitive query parameters in a URL, then applies `redact.url`. */
	function redactUrl(url, request) {
		let out = String(url);
		const mark = out.indexOf('?');
		if (mark !== -1) {
			const hash = out.indexOf('#', mark);
			const query = hash === -1 ? out.slice(mark + 1) : out.slice(mark + 1, hash);
			out = out.slice(0, mark + 1) + redactPairs(query) + (hash === -1 ? '' : out.slice(hash));
		}
		if (urlHook) {
			try {
				out = String(urlHook(out, request));
			} catch (error) {
				out = '[url]';
			}
		}
		return out;
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
		sensitive,
		redactHeaders,
		redactUrl,
		redactBody,
		redacted: REDACTED,
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
		/**
		 * A line about a request (sent, retried, answered, failed). The console gets the message; a custom
		 * logger also gets the facts, to print a line of its own or to keep request timings.
		 */
		event(level, message, facts) {
			if (enabled) {
				write(level, message, sink ? facts : undefined);
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
