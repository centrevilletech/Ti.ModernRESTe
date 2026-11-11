'use strict';

const { isFunction, isPlainObject } = require('./util');

const DEFAULTS = {
	retries: 2, // sends after the first one
	baseDelay: 500,
	maxDelay: 8000,
	factor: 2,
	jitter: 0.25, // +/- 25 %
	methods: ['GET', 'HEAD'],
	statuses: [502, 503, 504],
	kinds: ['network', 'timeout'],
	retryAfter: true, // wait as long as the server's Retry-After asks (up to maxRetryAfter)
	maxRetryAfter: 30000,
	shouldRetry: null
};

/**
 * Turns `true`, `false`, a number of retries or an object into a full policy, layered over `base`.
 * Returns null when retries are off.
 */
function normalizeRetry(value, base) {
	if (value === false || value === 0) {
		return null;
	}
	if (value === undefined || value === null) {
		return base || null;
	}
	const policy = Object.assign({}, DEFAULTS, base || {});
	if (value === true) {
		return policy;
	}
	if (typeof value === 'number') {
		policy.retries = value;
		return policy;
	}
	if (isPlainObject(value)) {
		Object.assign(policy, value);
		return policy;
	}
	return policy;
}

/**
 * Whether a request may be sent again at all: GET / HEAD, a request that carries an idempotency key, or an
 * endpoint that says repeating it is harmless (`retry: true` or a retry object on the method definition).
 */
function isRepeatable(policy, request) {
	if (request.endpointRetry) {
		return true;
	}
	if (request.idempotencyKey) {
		return true;
	}
	return policy.methods.indexOf(request.method) !== -1;
}

/**
 * Whether to send again after `error` on attempt number `attempt` (1 is the first send).
 * Never for a cancelled or stale request, never for a request that is not safe to repeat.
 */
function shouldRetry(policy, error, attempt, request) {
	if (!policy || attempt > policy.retries) {
		return false;
	}
	if (error.kind === 'cancelled' || error.kind === 'stale' || error.kind === 'params' || error.kind === 'config') {
		return false;
	}
	if (!isRepeatable(policy, request)) {
		return false;
	}
	if (isFunction(policy.shouldRetry)) {
		const verdict = policy.shouldRetry(error, attempt, request);
		if (verdict === true || verdict === false) {
			return verdict;
		}
	}
	if (error.kind === 'http') {
		return policy.statuses.indexOf(error.status) !== -1;
	}
	return policy.kinds.indexOf(error.kind) !== -1;
}

/**
 * Milliseconds to wait before attempt `attempt + 1`: base * factor^(attempt-1), capped, with jitter; the
 * server's Retry-After wins when it asks for longer (itself capped by maxRetryAfter).
 */
function retryDelay(policy, attempt, error, random) {
	const base = Math.min(policy.maxDelay, policy.baseDelay * Math.pow(policy.factor, attempt - 1));
	const spread = policy.jitter > 0 ? 1 - policy.jitter + (random || Math.random)() * policy.jitter * 2 : 1;
	let delay = Math.round(base * spread);
	if (policy.retryAfter && error && error.retryAfter != null) {
		delay = Math.max(delay, Math.min(error.retryAfter, policy.maxRetryAfter));
	}
	return delay;
}

module.exports = { normalizeRetry, shouldRetry, retryDelay, isRepeatable, RETRY_DEFAULTS: DEFAULTS };
