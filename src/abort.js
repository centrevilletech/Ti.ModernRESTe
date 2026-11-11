'use strict';

/**
 * A minimal abort controller (Titanium's JavaScript engines do not ship AbortController everywhere).
 *
 *   const controller = Reste.createAbortController();
 *   api.getJobs({}, { signal: controller.signal });
 *   controller.abort();                       // every request given this signal is cancelled
 *
 * One controller can be handed to any number of requests (all the requests of a screen, say). A native
 * AbortController's signal is accepted wherever a signal is.
 */
function createAbortController() {
	const listeners = [];
	const signal = {
		aborted: false,
		reason: undefined,
		addEventListener(type, listener) {
			if (type === 'abort' && listeners.indexOf(listener) === -1) {
				listeners.push(listener);
			}
		},
		removeEventListener(type, listener) {
			const index = type === 'abort' ? listeners.indexOf(listener) : -1;
			if (index !== -1) {
				listeners.splice(index, 1);
			}
		}
	};
	return {
		signal,
		get aborted() {
			return signal.aborted;
		},
		abort(reason) {
			if (signal.aborted) {
				return;
			}
			signal.aborted = true;
			signal.reason = reason;
			const pending = listeners.splice(0, listeners.length);
			for (let i = 0; i < pending.length; i++) {
				try {
					pending[i]({ type: 'abort', target: signal });
				} catch (error) {
					// A listener's failure must not stop the others from being cancelled.
					setTimeout(() => {
						throw error;
					}, 0);
				}
			}
		}
	};
}

/** Calls `onAbort` when the signal aborts; returns a function that stops listening. */
function watchSignal(signal, onAbort) {
	if (!signal) {
		return null;
	}
	const listener = () => onAbort(signal.reason);
	signal.addEventListener('abort', listener);
	return () => signal.removeEventListener('abort', listener);
}

module.exports = { createAbortController, watchSignal };
