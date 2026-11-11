#!/usr/bin/env node
'use strict';

/**
 * Runs the 1.x scenarios (scenarios.js) against one build and prints what each of them did, as JSON.
 *
 *   node test/differential/runner.js upstream 1.4.0     upstream RESTe, read out of this repository's history
 *   node test/differential/runner.js fork 1.4.0         this build (the bundle when RESTE_ENTRY=bundle)
 *
 * It runs in its own process because upstream replaces Backbone.sync and throws inside HTTP callbacks; both
 * would disturb a test run. test/unit/differential.test.js compares the two outputs.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { installFakeTi } = require('../helpers/ti');

const UPSTREAM_REF = 'e54b51d';
const root = path.join(__dirname, '..', '..');
const build = process.argv[2];
const version = process.argv[3] || '1.4.0';

function loadBuild() {
	if (build === 'upstream') {
		const source = execFileSync('git', ['show', UPSTREAM_REF + ':reste.js'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		const file = path.join(os.tmpdir(), 'reste-upstream-' + UPSTREAM_REF + '-' + process.pid + '.js');
		fs.writeFileSync(file, source);
		try {
			return require(file);
		} finally {
			fs.unlinkSync(file);
		}
	}
	return require('../helpers/reste');
}

let Reste;
try {
	Reste = loadBuild();
} catch (error) {
	process.stdout.write(JSON.stringify({ unavailable: String(error && error.message ? error.message : error) }) + '\n');
	process.exit(0);
}

const Backbone = require('backbone-' + version);
const originalSync = Backbone.sync;
global._ = require('underscore');
global.Backbone = Backbone;

/** A comparable copy of a value: no functions, no HTTP clients, models and collections as their JSON. */
function plain(value, depth) {
	const level = depth || 0;
	if (value === undefined) {
		return '<undefined>';
	}
	if (typeof value === 'function') {
		return '<function>';
	}
	if (value === null || typeof value !== 'object') {
		return value;
	}
	if (level > 4) {
		return '<deep>';
	}
	if (value.apiName) {
		return '<' + value.apiName + '>';
	}
	if (value instanceof Backbone.Model) {
		return { model: plain(value.toJSON(), level + 1) };
	}
	if (value instanceof Backbone.Collection) {
		return { collection: plain(value.toJSON(), level + 1) };
	}
	if (Array.isArray(value)) {
		return value.map(item => plain(item, level + 1));
	}
	const out = {};
	Object.keys(value).sort().forEach((key) => {
		out[key] = key === 'source' || key === 'http' || key === 'cause' ? '<object>' : plain(value[key], level + 1);
	});
	return out;
}

const scenarios = require('./scenarios');
const results = {};
let log = [];

process.on('uncaughtException', (error) => {
	log.push(['UNCAUGHT', String(error && error.message ? error.message : error)]);
});
process.on('unhandledRejection', (error) => {
	log.push(['UNHANDLED REJECTION', String(error && error.message ? error.message : error)]);
});

const wait = ms => new Promise(resolve => setTimeout(resolve, ms === undefined ? 5 : ms));

(async () => {
	const names = Object.keys(scenarios);
	for (let i = 0; i < names.length; i++) {
		const name = names[i];
		log = results[name] = [];
		const ti = installFakeTi();
		global.Alloy = { Collections: {}, Models: {}, Backbone };
		Backbone.sync = originalSync;
		const record = function (label) {
			log.push([label].concat(Array.prototype.slice.call(arguments, 1).map(item => plain(item))));
		};
		try {
			await scenarios[name]({ Reste, ti, record, Backbone, wait });
		} catch (error) {
			log.push(['THREW', String(error && error.message ? error.message : error)]);
		}
		await wait(30);
		ti.requests.forEach((request) => {
			log.push(['request', request.method, request.url, plain(request.headers), typeof request.body === 'string' ? request.body : plain(request.body)]);
		});
		ti.uninstall();
	}
	process.stdout.write(JSON.stringify(results) + '\n');
})();
