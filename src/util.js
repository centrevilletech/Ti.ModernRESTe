'use strict';

/* Small helpers shared by every module. No dependencies, nothing Titanium specific. */

const hasOwn = Object.prototype.hasOwnProperty;
const toString = Object.prototype.toString;

function has(object, key) {
	return object != null && hasOwn.call(object, key);
}

function isFunction(value) {
	return typeof value === 'function';
}

function isObject(value) {
	return value !== null && typeof value === 'object';
}

function isPlainObject(value) {
	if (!isObject(value) || toString.call(value) !== '[object Object]') {
		return false;
	}
	const proto = Object.getPrototypeOf(value);
	return proto === null || proto === Object.prototype;
}

function noop() {}

function now() {
	return Date.now();
}

/** Reads `a.b.c` (or a function of the object) from an object; undefined when a step is missing. */
function getPath(object, path, extra) {
	if (path == null || path === '') {
		return object;
	}
	if (isFunction(path)) {
		return path(object, extra);
	}
	if (!isObject(object)) {
		return undefined;
	}
	if (has(object, path)) {
		return object[path];
	}
	if (path.indexOf('.') === -1) {
		return undefined;
	}
	const steps = path.split('.');
	let value = object;
	for (let i = 0; i < steps.length; i++) {
		if (!isObject(value)) {
			return undefined;
		}
		value = value[steps[i]];
	}
	return value;
}

/** Structural equality for JSON-like values (what an API sends back). */
function deepEqual(a, b) {
	if (a === b) {
		return true;
	}
	if (!isObject(a) || !isObject(b)) {
		// NaN never arrives in JSON, but a model may hold one.
		return a !== a && b !== b;  
	}
	const aIsArray = Array.isArray(a);
	if (aIsArray !== Array.isArray(b)) {
		return false;
	}
	if (aIsArray) {
		if (a.length !== b.length) {
			return false;
		}
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) {
				return false;
			}
		}
		return true;
	}
	if (a instanceof Date || b instanceof Date) {
		return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
	}
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) {
		return false;
	}
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		if (!hasOwn.call(b, key) || !deepEqual(a[key], b[key])) {
			return false;
		}
	}
	return true;
}

/** 32-bit FNV-1a of a string, as 8 hex characters. Used for cache file names and unchanged-body checks. */
function hashString(text) {
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
	}
	return ('0000000' + hash.toString(16)).slice(-8);
}

/** A random RFC 4122 version 4 UUID; the platform's generator when Titanium is present. */
function uuid() {
	if (typeof Ti !== 'undefined' && Ti.Platform && isFunction(Ti.Platform.createUUID)) {
		return String(Ti.Platform.createUUID()).toLowerCase();
	}
	let out = '';
	for (let i = 0; i < 36; i++) {
		if (i === 8 || i === 13 || i === 18 || i === 23) {
			out += '-';
		} else if (i === 14) {
			out += '4';
		} else {
			const random = Math.random() * 16 | 0;
			out += (i === 19 ? (random & 0x3) | 0x8 : random).toString(16);
		}
	}
	return out;
}

/** True for the values Titanium sends as a file part: Ti.Blob, Ti.Filesystem.File, Ti.Buffer. */
function isBinary(value) {
	if (!isObject(value)) {
		return false;
	}
	const apiName = value.apiName;
	return apiName === 'Ti.Blob' || apiName === 'Ti.Filesystem.File' || apiName === 'Ti.Buffer';
}

/** Lower-cases the keys of a header object. */
function lowerKeys(object) {
	const out = {};
	if (object) {
		const keys = Object.keys(object);
		for (let i = 0; i < keys.length; i++) {
			out[keys[i].toLowerCase()] = object[keys[i]];
		}
	}
	return out;
}

/** Finds a header by name whatever its case; returns the key in use or null. */
function headerKey(headers, name) {
	if (has(headers, name)) {
		return name;
	}
	const wanted = name.toLowerCase();
	const keys = Object.keys(headers);
	for (let i = 0; i < keys.length; i++) {
		if (keys[i].toLowerCase() === wanted) {
			return keys[i];
		}
	}
	return null;
}

/** Calls `fn` on a later turn of the event loop. */
function later(fn, ms) {
	return setTimeout(fn, ms || 0);
}

module.exports = {
	has,
	isFunction,
	isObject,
	isPlainObject,
	noop,
	now,
	getPath,
	deepEqual,
	hashString,
	uuid,
	isBinary,
	lowerKeys,
	headerKey,
	later
};
