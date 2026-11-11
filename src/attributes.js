'use strict';

const { deepEqual, isObject, has } = require('./util');

/**
 * The attributes of `incoming` that differ from `current`, or null when none do. Keys `incoming` lacks are
 * left alone: a list row usually carries fewer fields than the detail of the same resource. `pending` names
 * attributes to leave alone as well (optimistic changes in flight).
 */
function diffAttributes(current, incoming, pending) {
	let diff = null;
	const keys = Object.keys(incoming);
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		if (pending && pending[key] > 0) {
			continue; // changed on the device, not answered by the server yet: the device's value stands
		}
		const a = current[key];
		const b = incoming[key];
		if (a === b) {
			continue;
		}
		if (isObject(a) && isObject(b) && deepEqual(a, b)) {
			continue;
		}
		(diff || (diff = {}))[key] = b;
	}
	return diff;
}

/** Makes a Backbone model hold exactly `next`: keys it lacks are removed; only real changes fire. */
function replaceAttributes(model, next) {
	const gone = Object.keys(model.attributes).filter(key => !has(next, key));
	gone.forEach(key => model.unset(key));
	const diff = diffAttributes(model.attributes, next);
	if (diff) {
		model.set(diff);
	}
	return model;
}

module.exports = { diffAttributes, replaceAttributes };
