'use strict';

/**
 * Idempotency keys per logical action.
 *
 * One call is one action: it gets one key, and every automatic retry of that call reuses it. When the *user*
 * repeats an action (taps Retry after a timeout with the form unchanged) the app wants the same key again;
 * naming the action does that:
 *
 *   api.createOrder({ body }, { action: 'checkout' })    // same body -> same key until it succeeds
 *
 * or by hand:
 *
 *   const key = api.idempotency.key('checkout', body);
 *   api.createOrder({ body }, { idempotencyKey: key }).then(() => api.idempotency.done('checkout'));
 *
 * A changed payload gets a new key. Keys live in memory only.
 */
function createKeys(generate) {
	const actions = Object.create(null); // action -> { fingerprint, key }

	function fingerprint(payload) {
		try {
			return JSON.stringify(payload === undefined ? null : payload);
		} catch (error) {
			return String(Math.random()); // not serialisable (a blob): never reuse
		}
	}

	return {
		/** The key for `action` with this payload: the previous one while the payload is unchanged. */
		key(action, payload) {
			const print = fingerprint(payload);
			const current = actions[action];
			if (current && current.fingerprint === print) {
				return current.key;
			}
			const key = generate();
			actions[action] = { fingerprint: print, key };
			return key;
		},
		/** The action reached a final answer: the next one gets a new key. */
		done(action) {
			delete actions[action];
		},
		/** A new key that belongs to no action. */
		generate() {
			return generate();
		},
		clear() {
			Object.keys(actions).forEach((action) => {
				delete actions[action];
			});
		}
	};
}

module.exports = { createKeys };
