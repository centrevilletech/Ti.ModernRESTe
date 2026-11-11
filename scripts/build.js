#!/usr/bin/env node
'use strict';

/**
 * Builds what people drop into app/lib: src/*.js -> reste.js (one file with everything), and the same
 * library as two files under split/ for apps that count the milliseconds of a cold start.
 *
 *   node scripts/build.js           write reste.js, split/reste.js and split/reste.data.js
 *   node scripts/build.js --check   exit 1 when one of them is not what the sources produce
 *
 * No bundler: every source file becomes one function in a small module table. The order of the table does
 * not matter, modules are evaluated on first require.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sourceDir = path.join(root, 'src');
const version = require(path.join(root, 'package.json')).version;

const HEADER = `/*!
 * RESTe ${version}
 * A JavaScript REST / API helper for Titanium with Alloy Models/Collections support.
 *
 * Copyright Jason Kneen
 * Modifications Copyright 2026 Centreville Tech LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * This file is a modified version of RESTe (https://github.com/jasonkneen/RESTe).
 * It is generated from src/ by scripts/build.js: edit the sources, not this file.
 */
`;

/** The part that is loaded on first use; in the two-file build it is the second file. */
const DATA = ['./identity', './list', './merge', './pagination', './sync'];

function moduleTable(names) {
	return names.map((name) => {
		const source = fs.readFileSync(path.join(sourceDir, name.slice(2) + '.js'), 'utf8').replace(/^'use strict';\n+/, '');
		const body = source.split('\n').map(line => (line ? '\t\t' + line : line)).join('\n').replace(/\s+$/, '');
		return `\t${JSON.stringify(name)}: function (module, exports, require) {\n${body}\n\t}`;
	}).join(',\n');
}

/**
 * Everything the build writes, by path relative to the repository:
 *   reste.js                 the one file with everything (the default: copy it into app/lib)
 *   split/reste.js           the same library without models, collections, lists and pagination ...
 *   split/reste.data.js      ... which it reads from this file, next to it, when they are first needed
 */
function build() {
	const names = fs.readdirSync(sourceDir).filter(file => file.endsWith('.js')).sort().map(file => './' + file.replace(/\.js$/, ''));
	DATA.forEach((name) => {
		if (names.indexOf(name) === -1) {
			throw new Error('scripts/build.js: no source for ' + name);
		}
	});
	const loader = second => `(function () {
	'use strict';

	var cache = {};
	var modules = {
${moduleTable(second ? names.filter(name => DATA.indexOf(name) === -1) : names)}
	};

	function load(name) {
		if (!cache[name]) {${second ? `
			if (!modules[name]) {
				// Models, collections, lists and pagination: the second file, read when one of them is first needed.
				var more = require('./reste.data');
				Object.keys(more).forEach(function (key) {
					modules[key] = more[key];
				});
			}` : ''}
			var loaded = cache[name] = { exports: {} };
			modules[name](loaded, loaded.exports, load);
		}
		return cache[name].exports;
	}

	module.exports = load('./index');
}());
`;
	return {
		'reste.js': HEADER + loader(false),
		'split/reste.js': HEADER + loader(true),
		'split/reste.data.js': `${HEADER}'use strict';

// The second file of the two-file build: reste.js, next to it, reads it on first use. Not for use on its own.
module.exports = {
${moduleTable(DATA)}
};
`
	};
}

const outputs = build();
const stale = Object.keys(outputs).filter((file) => {
	const target = path.join(root, file);
	return !fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== outputs[file];
});
if (process.argv.includes('--check')) {
	if (stale.length) {
		console.error(stale.join(', ') + ' out of date: run `npm run build`');
		process.exit(1);
	}
	console.log(Object.keys(outputs).join(', ') + ' up to date');
} else {
	Object.keys(outputs).forEach((file) => {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), outputs[file]);
		console.log('wrote ' + file + ' (' + (outputs[file].length / 1024).toFixed(1) + ' kB, ' + outputs[file].split('\n').length + ' lines)');
	});
}
