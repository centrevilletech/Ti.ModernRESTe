'use strict';

/*
 * Drop-in compatibility, checked mechanically: every scenario of test/differential/scenarios.js (what 1.x
 * apps do, from upstream's README) runs against upstream RESTe and against this build, on three Backbone
 * versions. A scenario must do the same in both (the callbacks called, their arguments, the requests sent)
 * unless it is listed below with the row of the README's migration table that explains the difference. A
 * listed scenario must really differ, so the list cannot go stale.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const DIFFERENT = {
	'a path value that needs encoding': 'path values are URI-encoded',
	'an object for a placeholder': 'path values are URI-encoded',
	'an empty string for a placeholder in the path': 'an empty path value rejects instead of sending "videos/"',
	'a missing placeholder without validation': 'a missing placeholder rejects instead of being sent as <name>',
	'a missing placeholder with autoValidateParams': 'rejects instead of throwing',
	'expects with a missing parameter': 'rejects instead of throwing',
	'a string body': 'a string body is sent as it is',
	'a JSON body without a Content-Type header configured': 'a JSON body gets Content-Type: application/json',
	'a form-encoded body with nested values': 'nested form values are flattened to name[child]',
	'DELETE without a body': 'a DELETE without a body sends none (upstream master sent "{}", 1.6.0 none)',
	'a method with a full URL on another host': 'default headers are not sent to another origin',
	'config() twice': 'config() can be called again',
	'method(onLoad, onError) without params': 'upstream used the error callback for success',
	'a 204 without a body': 'an empty body is null, not an empty string',
	'text that claims to be JSON': 'invalid JSON with a JSON content type is an error',
	'a 404 with only a success callback': 'errors no longer go to the success callback',
	'a 404 with an error callback': 'errors are objects by default',
	'the url and the error text of an error object': 'error.url is the full URL',
	'the README sample that tests e.message, with the default error setting': 'errors are objects by default: read error.content.message',
	'beforePost and beforeSend on a POST': 'both hooks run for a POST',
	'a collection without an id setting keeps the items\' ids': 'upstream overwrote id with undefined',
	'destroy a model that was loaded': 'destroy() sends no body',
	'a successful save whose body has a code field': 'only the HTTP status decides'
};

/** Request bodies of DELETEs are compared in their own scenarios only. */
const RAW = ['DELETE without a body', 'destroy a model that was loaded'];

function run(build, version) {
	const output = execFileSync(process.execPath, [path.join(__dirname, '..', 'differential', 'runner.js'), build, version], {
		encoding: 'utf8', env: process.env, stdio: ['ignore', 'pipe', 'ignore']
	});
	return JSON.parse(output.trim().split('\n').pop());
}

function comparable(name, log) {
	return JSON.stringify(log.map((entry) => {
		if (entry[0] === 'request' && entry[1] === 'DELETE' && RAW.indexOf(name) === -1) {
			return entry.slice(0, 4);
		}
		return entry;
	}));
}

['0.9.2', '1.4.0', '1.6.0'].forEach((version) => {
	describe('1.x scenarios, upstream and this build side by side, Backbone ' + version, () => {
		let upstream;
		let fork;

		before(() => {
			upstream = run('upstream', version);
			fork = run('fork', version);
		});

		it('ran against upstream from this repository\'s history', (t) => {
			if (upstream.unavailable) {
				t.skip('upstream is not available here: ' + upstream.unavailable);
				return;
			}
			assert.ok(Object.keys(upstream).length > 50);
			assert.deepEqual(Object.keys(fork), Object.keys(upstream));
		});

		it('does what upstream does, except where the migration table says otherwise', (t) => {
			if (upstream.unavailable) {
				t.skip('upstream is not available here');
				return;
			}
			const unexpected = [];
			const stale = [];
			Object.keys(upstream).forEach((name) => {
				const same = comparable(name, upstream[name]) === comparable(name, fork[name]);
				if (!same && !DIFFERENT[name]) {
					unexpected.push(name + '\n    upstream: ' + comparable(name, upstream[name]) + '\n    this build: ' + comparable(name, fork[name]));
				}
				if (same && DIFFERENT[name]) {
					stale.push(name);
				}
			});
			assert.deepEqual(unexpected, [], 'undocumented differences from 1.x');
			assert.deepEqual(stale, [], 'listed as different but behave the same');
			Object.keys(DIFFERENT).forEach(name => assert.ok(upstream[name], 'no such scenario: ' + name));
		});

		it('throws nothing that upstream did not throw', (t) => {
			if (upstream.unavailable) {
				t.skip('upstream is not available here');
				return;
			}
			Object.keys(fork).forEach((name) => {
				const uncaught = fork[name].filter(entry => /^(UNCAUGHT|UNHANDLED|THREW)/.test(entry[0]));
				const before = upstream[name].filter(entry => /^(UNCAUGHT|UNHANDLED|THREW)/.test(entry[0]));
				assert.ok(uncaught.length <= before.length, name + ': ' + JSON.stringify(uncaught));
			});
		});
	});
});
