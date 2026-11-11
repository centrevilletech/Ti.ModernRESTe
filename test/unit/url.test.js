'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { compileTemplate, fillTemplate, serializeQuery, withQuery, joinUrl, isAbsolute, flattenFields, hasBinary } = require('../../src/url');
const { FakeBlob } = require('../helpers/ti');

describe('path templates', () => {
	it('fills placeholders and encodes their values', () => {
		const template = compileTemplate('jobs/<job>/offers/<offer>');
		assert.deepEqual(template.names, ['job', 'offer']);
		assert.equal(fillTemplate(template, { job: 'a b', offer: 'x/y' }, true, 'm'), 'jobs/a%20b/offers/x%2Fy');
	});

	it('leaves values alone when encoding is off', () => {
		assert.equal(fillTemplate(compileTemplate('files/<path>'), { path: 'a/b c' }, false, 'm'), 'files/a/b c');
	});

	it('sends objects as JSON, as upstream did', () => {
		assert.equal(fillTemplate(compileTemplate('q?where=<where>'), { where: { name: 'x' } }, true, 'm'),
			'q?where=' + encodeURIComponent('{"name":"x"}'));
	});

	it('accepts 0 and false as values', () => {
		assert.equal(fillTemplate(compileTemplate('p/<n>/<flag>'), { n: 0, flag: false }, true, 'm'), 'p/0/false');
	});

	it('names every missing placeholder in one params error', () => {
		assert.throws(() => fillTemplate(compileTemplate('a/<one>/<two>/<three>'), { two: 2, three: '' }, true, 'getA'), (error) => {
			assert.equal(error.kind, 'params');
			assert.deepEqual(error.missing, ['one', 'three']);
			assert.match(error.message, /missing parameter\/s <one>,<three> for method getA/);
			return true;
		});
	});

	it('does not loop when a value contains its own placeholder', () => {
		// Upstream replaced in a while loop and never finished for { id: '<id>' }.
		assert.equal(fillTemplate(compileTemplate('v/<id>'), { id: '<id>' }, false, 'm'), 'v/<id>');
	});

	it('returns a template without placeholders untouched', () => {
		assert.equal(fillTemplate(compileTemplate('videos'), null, true, 'm'), 'videos');
	});
});

describe('query strings', () => {
	it('skips null and undefined, keeps 0, false and empty strings', () => {
		assert.equal(serializeQuery({ a: 1, b: null, c: undefined, d: 0, e: false, f: '' }), 'a=1&d=0&e=false&f=');
	});

	it('can skip empty strings and send nulls as empty', () => {
		assert.equal(serializeQuery({ a: '', b: null }, { arrayFormat: 'brackets', nulls: 'empty', skipEmptyString: true }), 'b=');
	});

	it('writes arrays as key[]= by default', () => {
		assert.equal(serializeQuery({ tags: ['a', 'b c'] }), 'tags%5B%5D=a&tags%5B%5D=b%20c');
	});

	it('supports repeat, indices and comma arrays', () => {
		assert.equal(serializeQuery({ t: [1, 2] }, { arrayFormat: 'repeat' }), 't=1&t=2');
		assert.equal(serializeQuery({ t: [1, 2] }, { arrayFormat: 'indices' }), 't%5B0%5D=1&t%5B1%5D=2');
		assert.equal(serializeQuery({ t: [1, null, 2] }, { arrayFormat: 'comma' }), 't=1%2C2');
	});

	it('skips null array members', () => {
		assert.equal(serializeQuery({ t: [1, null, undefined, 2] }, { arrayFormat: 'repeat' }), 't=1&t=2');
	});

	it('writes nested objects with brackets and dates as ISO strings', () => {
		assert.equal(decodeURIComponent(serializeQuery({ filter: { status: 'open', range: { from: 1 } } })), 'filter[status]=open&filter[range][from]=1');
		assert.equal(serializeQuery({ since: new Date(0) }), 'since=1970-01-01T00%3A00%3A00.000Z');
	});

	it('appends to a URL that already has a query, before a fragment', () => {
		assert.equal(withQuery('a', 'x=1'), 'a?x=1');
		assert.equal(withQuery('a?y=2', 'x=1'), 'a?y=2&x=1');
		assert.equal(withQuery('a?', 'x=1'), 'a?x=1');
		assert.equal(withQuery('a#top', 'x=1'), 'a?x=1#top');
		assert.equal(withQuery('a', ''), 'a');
	});
});

describe('joining URLs', () => {
	it('puts exactly one slash between base and path', () => {
		assert.equal(joinUrl('https://h/v1/', 'videos'), 'https://h/v1/videos');
		assert.equal(joinUrl('https://h/v1', 'videos'), 'https://h/v1/videos');
		assert.equal(joinUrl('https://h/v1/', '/videos'), 'https://h/v1/videos');
		assert.equal(joinUrl('https://h/v1', '?a=1'), 'https://h/v1?a=1');
	});

	it('recognises absolute URLs by their scheme, not by an "http" prefix', () => {
		assert.equal(isAbsolute('https://other/x'), true);
		assert.equal(isAbsolute('httpstatus/200'), false); // upstream treated this as absolute
		assert.equal(joinUrl('https://h/', 'httpstatus/200'), 'https://h/httpstatus/200');
		assert.equal(joinUrl('https://h/', 'http://other/x'), 'http://other/x');
		assert.equal(joinUrl(undefined, 'videos'), 'videos');
	});
});

describe('multipart and form fields', () => {
	it('flattens arrays and nested objects, drops nulls, keeps binaries', () => {
		const blob = new FakeBlob('x');
		const flat = flattenFields({ 'photos[]': [blob, blob], tags: ['a', 'b'], meta: { note: 'n', deep: { n: 1 } }, flag: true, none: null, at: new Date(0) });
		assert.deepEqual(Object.keys(flat), ['photos[0]', 'photos[1]', 'tags[0]', 'tags[1]', 'meta[note]', 'meta[deep][n]', 'flag', 'at']);
		assert.equal(flat['photos[1]'], blob);
		assert.equal(flat.flag, 'true');
		assert.equal(flat['meta[deep][n]'], '1');
		assert.equal(flat.at, '1970-01-01T00:00:00.000Z');
	});

	it('finds binaries at any depth', () => {
		assert.equal(hasBinary({ a: 1, b: { c: [new FakeBlob('x')] } }), true);
		assert.equal(hasBinary({ a: 1, b: { c: ['x'] }, d: new Date() }), false);
		assert.equal(hasBinary('text'), false);
	});
});
