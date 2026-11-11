'use strict';

/**
 * One model instance per id.
 *
 * Where the JavaScript engine has WeakRef the map holds its models weakly: a model stays as long as anything
 * else holds it (a collection, a screen), and is forgotten when nothing does. Without WeakRef it holds them
 * strongly and, past `limit`, drops the oldest ones that no collection holds (`held(model)`).
 *
 * options: { weak (default: when available), limit (default 1000), held(model) -> boolean }
 */
function createIdentityMap(options) {
	const settings = options || {};
	const weak = settings.weak !== false && typeof WeakRef === 'function';
	const limit = settings.limit > 0 ? settings.limit : 1000;
	const held = settings.held || (() => false);
	const map = new Map(); // id -> model, or a WeakRef to it
	let writes = 0;

	function read(id) {
		const value = map.get(id);
		if (value === undefined) {
			return undefined;
		}
		if (!weak) {
			return value;
		}
		const model = value.deref();
		if (model === undefined) {
			map.delete(id);
		}
		return model;
	}

	/** Weak mode: forget the ids whose model is gone. */
	function sweep() {
		map.forEach((value, id) => {
			if (value.deref() === undefined) {
				map.delete(id);
			}
		});
	}

	/** Strong mode: back under the limit by dropping the oldest models that no collection holds. */
	function trim() {
		const ids = Array.from(map.keys());
		for (let i = 0; i < ids.length && map.size > limit; i++) {
			if (!held(map.get(ids[i]))) {
				map.delete(ids[i]);
			}
		}
	}

	return {
		weak,
		get: read,
		has: id => read(id) !== undefined,
		set(id, model) {
			map.delete(id);
			map.set(id, weak ? new WeakRef(model) : model);
			writes++;
			if (weak) {
				if (writes % 512 === 0) {
					sweep();
				}
			} else if (map.size > limit) {
				trim();
			}
		},
		delete: id => map.delete(id),
		clear: () => map.clear(),
		get size() {
			if (weak) {
				sweep();
			}
			return map.size;
		}
	};
}

module.exports = { createIdentityMap };
