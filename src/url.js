'use strict';

const { ResteError } = require('./errors');
const { isObject, isBinary } = require('./util');

const PLACEHOLDER = /<(\w+)>/g;
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Splits `jobs/<job>/offers/<offer>` once into literals and names so a call only joins strings.
 * @returns {{source: string, literals: string[], names: string[]}}
 */
function compileTemplate(source) {
	const literals = [];
	const names = [];
	const inQuery = []; // per placeholder: it sits after the "?" (an empty value is fine there)
	let last = 0;
	let match;
	PLACEHOLDER.lastIndex = 0;
	while ((match = PLACEHOLDER.exec(source)) !== null) {
		literals.push(source.slice(last, match.index));
		names.push(match[1]);
		inQuery.push(source.lastIndexOf('?', match.index) !== -1);
		last = match.index + match[0].length;
	}
	literals.push(source.slice(last));
	return { source, literals, names, inQuery };
}

/**
 * Fills a compiled template. Objects are sent as JSON, as upstream did. Throws a ResteError('params') naming
 * every placeholder that has no value: null and undefined anywhere, and an empty string in the path (where
 * it would turn `things/<id>` into the URL of the whole list), but not in the query string.
 */
function fillTemplate(template, params, encode, endpointName) {
	const names = template.names;
	if (names.length === 0) {
		return template.source;
	}
	const literals = template.literals;
	let out = literals[0];
	let missing = null;
	for (let i = 0; i < names.length; i++) {
		let value = params ? params[names[i]] : undefined;
		if (value === null || value === undefined || (value === '' && !template.inQuery[i])) {
			(missing || (missing = [])).push(names[i]);
		} else {
			if (isObject(value)) {
				value = JSON.stringify(value);
			}
			out += encode ? encodeURIComponent(value) : value;
		}
		out += literals[i + 1];
	}
	if (missing) {
		throw ResteError('params', 'RESTe :: missing parameter/s ' + missing.map(name => '<' + name + '>').join(',')
			+ ' for method ' + endpointName, { endpoint: endpointName, missing });
	}
	return out;
}

function encodePair(key, value) {
	return encodeURIComponent(key) + '=' + encodeURIComponent(value);
}

function scalar(value) {
	if (value instanceof Date) {
		return value.toISOString();
	}
	return value;
}

function appendQuery(parts, key, value, options) {
	if (value === undefined || value === null) {
		if (value === null && options.nulls === 'empty') {
			parts.push(encodeURIComponent(key) + '=');
		}
		return;
	}
	if (value === '' && options.skipEmptyString) {
		return;
	}
	if (Array.isArray(value)) {
		const format = options.arrayFormat;
		if (format === 'comma') {
			const kept = value.filter(item => item !== null && item !== undefined).map(scalar);
			if (kept.length) {
				parts.push(encodePair(key, kept.join(',')));
			}
			return;
		}
		for (let i = 0; i < value.length; i++) {
			const item = value[i];
			if (isObject(item) && !(item instanceof Date)) {
				appendQuery(parts, key + '[' + i + ']', item, options);
			} else if (format === 'repeat') {
				appendQuery(parts, key, item, options);
			} else if (format === 'indices') {
				appendQuery(parts, key + '[' + i + ']', item, options);
			} else {
				appendQuery(parts, key + '[]', item, options);
			}
		}
		return;
	}
	if (value instanceof Date) {
		parts.push(encodePair(key, value.toISOString()));
		return;
	}
	if (isObject(value)) {
		const keys = Object.keys(value);
		for (let i = 0; i < keys.length; i++) {
			appendQuery(parts, key + '[' + keys[i] + ']', value[keys[i]], options);
		}
		return;
	}
	parts.push(encodePair(key, value));
}

const DEFAULT_QUERY_OPTIONS = { arrayFormat: 'brackets', nulls: 'skip', skipEmptyString: false };

/**
 * `{ status: 'open', tags: ['a', 'b'], page: 2, q: null }` -> `status=open&tags%5B%5D=a&tags%5B%5D=b&page=2`.
 * null and undefined are left out; arrays use `key[]=` unless `arrayFormat` says 'repeat', 'indices' or 'comma';
 * nested objects use `key[child]=`; booleans are true / false; dates are ISO 8601.
 */
function serializeQuery(query, options) {
	if (!query) {
		return '';
	}
	const settings = options || DEFAULT_QUERY_OPTIONS;
	const parts = [];
	const keys = Object.keys(query);
	for (let i = 0; i < keys.length; i++) {
		appendQuery(parts, keys[i], query[keys[i]], settings);
	}
	return parts.join('&');
}

function withQuery(url, queryString) {
	if (!queryString) {
		return url;
	}
	const hash = url.indexOf('#');
	const base = hash === -1 ? url : url.slice(0, hash);
	const fragment = hash === -1 ? '' : url.slice(hash);
	const separator = base.indexOf('?') === -1 ? '?' : (/[?&]$/.test(base) ? '' : '&');
	return base + separator + queryString + fragment;
}

function isAbsolute(url) {
	return ABSOLUTE.test(url);
}

/** Base URL + path with exactly one slash between them; an absolute path is returned as is. */
function joinUrl(base, path) {
	if (!base || isAbsolute(path)) {
		return path;
	}
	if (!path) {
		return base;
	}
	const baseSlash = base.charAt(base.length - 1) === '/';
	const pathSlash = path.charAt(0) === '/';
	if (baseSlash && pathSlash) {
		return base + path.slice(1);
	}
	if (!baseSlash && !pathSlash && path.charAt(0) !== '?') {
		return base + '/' + path;
	}
	return base + path;
}

/**
 * Flattens a body for multipart or form encoding, because Titanium's HTTP client takes one flat dictionary:
 * `{ photos: [a, b], meta: { note: 'x' } }` -> `{ 'photos[0]': a, 'photos[1]': b, 'meta[note]': 'x' }`.
 * A key that already ends in `[]` keeps its name: `'photos[]': [a, b]` -> `photos[0]`, `photos[1]`.
 * null and undefined are left out; booleans and numbers become strings (with `keepPrimitives`, top-level
 * ones are passed as they are); binary values pass through.
 */
function flattenFields(body, keepPrimitives) {
	const out = {};
	if (!body) {
		return out;
	}
	const keys = Object.keys(body);
	for (let i = 0; i < keys.length; i++) {
		const value = body[keys[i]];
		if (keepPrimitives && (typeof value === 'number' || typeof value === 'boolean')) {
			out[keys[i]] = value; // a flat form body reaches the HTTP client exactly as 1.x passed it
		} else {
			flattenField(out, keys[i], value);
		}
	}
	return out;
}

function flattenField(out, key, value) {
	if (value === null || value === undefined) {
		return;
	}
	if (isBinary(value)) {
		out[key] = value;
	} else if (Array.isArray(value)) {
		const stem = key.slice(-2) === '[]' ? key.slice(0, -2) : key;
		for (let i = 0; i < value.length; i++) {
			flattenField(out, stem + '[' + i + ']', value[i]);
		}
	} else if (value instanceof Date) {
		out[key] = value.toISOString();
	} else if (isObject(value)) {
		const keys = Object.keys(value);
		for (let i = 0; i < keys.length; i++) {
			flattenField(out, key + '[' + keys[i] + ']', value[keys[i]]);
		}
	} else if (typeof value === 'boolean') {
		out[key] = value ? 'true' : 'false';
	} else {
		out[key] = typeof value === 'string' ? value : String(value);
	}
}

/** True when any top-level or nested value of a body is a Ti.Blob / File / Buffer. */
function hasBinary(body) {
	if (!isObject(body)) {
		return false;
	}
	if (isBinary(body)) {
		return true;
	}
	const keys = Object.keys(body);
	for (let i = 0; i < keys.length; i++) {
		const value = body[keys[i]];
		if (isBinary(value) || (isObject(value) && !(value instanceof Date) && hasBinary(value))) {
			return true;
		}
	}
	return false;
}

module.exports = {
	compileTemplate,
	fillTemplate,
	serializeQuery,
	withQuery,
	isAbsolute,
	joinUrl,
	flattenFields,
	hasBinary,
	DEFAULT_QUERY_OPTIONS
};
