'use strict';

/**
 * The one error type every failed request ends in.
 *
 * kind      'http'       the server answered with a status outside 2xx (and not a 304 to a conditional GET)
 *           'network'    no response: connection refused, dropped, DNS, TLS (`offline` is true when the device
 *                        reported no connectivity)
 *           'timeout'    no response within the request's timeout (or its deadline)
 *           'cancelled'  aborted by the caller
 *           'stale'      the session ended (or the user changed) while the request was in flight; its response
 *                        was dropped
 *           'parse'      the response claimed to be JSON and was not
 *           'params'     a path parameter or an expected parameter is missing
 *           'config'     the request could not be built (unknown method, no read method on a model, ...)
 *
 * Fields: status, body (parsed), headers (lower-cased names), url, method, endpoint (the method name),
 * retryAfter (ms, from Retry-After), attempts, idempotencyKey, cause (the HTTP client's error event).
 * For code written against upstream's `errorsAsObjects: true` the same values are also available under the
 * names upstream used: success (false), code, content, error, type, source.
 */
function ResteError(kind, message, details) {
	const error = new Error(message || kind);
	Object.setPrototypeOf(error, ResteError.prototype);
	error.kind = kind;
	error.status = 0;
	error.body = null;
	error.headers = {};
	error.url = null;
	error.method = null;
	error.endpoint = null;
	error.retryAfter = null;
	error.attempts = 0;
	error.idempotencyKey = null;
	error.offline = false;
	error.cause = null;
	if (details) {
		const keys = Object.keys(details);
		for (let i = 0; i < keys.length; i++) {
			error[keys[i]] = details[keys[i]];
		}
	}
	// Upstream's `errorsAsObjects` shape.
	error.success = false;
	error.type = 'error';
	error.error = error.message;
	if (error.code === undefined) {
		error.code = error.status;
	}
	return error;
}

ResteError.prototype = Object.create(Error.prototype, {
	constructor: { value: ResteError, writable: true, configurable: true },
	name: { value: 'ResteError', writable: true, configurable: true },
	content: {
		get() {
			return this.body;
		},
		set(value) {
			this.body = value;
		},
		configurable: true
	},
	isHttp: {
		get() {
			return this.kind === 'http';
		},
		configurable: true
	},
	isNetwork: {
		get() {
			return this.kind === 'network';
		},
		configurable: true
	},
	isTimeout: {
		get() {
			return this.kind === 'timeout';
		},
		configurable: true
	},
	isCancelled: {
		get() {
			return this.kind === 'cancelled' || this.kind === 'stale';
		},
		configurable: true
	},
	isStale: {
		get() {
			return this.kind === 'stale';
		},
		configurable: true
	},
	isParse: {
		get() {
			return this.kind === 'parse';
		},
		configurable: true
	},
	isOffline: {
		get() {
			return this.offline === true;
		},
		configurable: true
	}
});

/** A plain, loggable copy without the HTTP client and without request headers. */
ResteError.prototype.toJSON = function () {
	return {
		name: this.name,
		kind: this.kind,
		message: this.message,
		status: this.status,
		body: this.body,
		url: this.url,
		method: this.method,
		endpoint: this.endpoint,
		retryAfter: this.retryAfter,
		attempts: this.attempts,
		offline: this.offline
	};
};

ResteError.is = function (value) {
	return value instanceof ResteError;
};

/** Retry-After as milliseconds: seconds, or an HTTP date. Null when absent or unreadable. */
function parseRetryAfter(value, nowMs) {
	if (value == null || value === '') {
		return null;
	}
	const text = String(value).trim();
	if (/^\d+(\.\d+)?$/.test(text)) {
		return Math.round(parseFloat(text) * 1000);
	}
	const date = Date.parse(text);
	if (isNaN(date)) {
		return null;
	}
	return Math.max(0, date - (nowMs === undefined ? Date.now() : nowMs));
}

const TIMEOUT_PATTERN = /time(d)?[\s-]?out/i;

/**
 * Why a request got no response. `event` is the HTTP client's error event, `elapsed` the time since send and
 * `timeout` the request's timeout: a failure that took at least the timeout is a timeout even when the
 * platform's message does not say so.
 */
function classifyFailure(event, elapsed, timeout) {
	const message = event && event.error != null ? String(event.error) : '';
	const code = event ? event.code : undefined;
	if (TIMEOUT_PATTERN.test(message) || code === -1001) {
		return 'timeout';
	}
	if (timeout > 0 && elapsed >= timeout) {
		return 'timeout';
	}
	return 'network';
}

module.exports = { ResteError, parseRetryAfter, classifyFailure };
