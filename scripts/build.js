#!/usr/bin/env node
'use strict';

/**
 * Builds the single file people drop into app/lib: src/*.js -> reste.js.
 *
 *   node scripts/build.js           write reste.js
 *   node scripts/build.js --check   exit 1 when reste.js is not what the sources produce
 *
 * No bundler: every source file becomes one function in a small module table. The order of the table does
 * not matter, modules are evaluated on first require.
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const sourceDir = path.join(root, 'src');
const target = path.join(root, 'reste.js');
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

function build() {
	const files = fs.readdirSync(sourceDir).filter(file => file.endsWith('.js')).sort();
	const modules = files.map((file) => {
		const name = './' + file.replace(/\.js$/, '');
		const source = fs.readFileSync(path.join(sourceDir, file), 'utf8').replace(/^'use strict';\n+/, '');
		const body = source.split('\n').map(line => (line ? '\t\t' + line : line)).join('\n').replace(/\s+$/, '');
		return `\t${JSON.stringify(name)}: function (module, exports, require) {\n${body}\n\t}`;
	});
	return `${HEADER}(function () {
	'use strict';

	var cache = {};
	var modules = {
${modules.join(',\n')}
	};

	function load(name) {
		if (!cache[name]) {
			var loaded = cache[name] = { exports: {} };
			modules[name](loaded, loaded.exports, load);
		}
		return cache[name].exports;
	}

	module.exports = load('./index');
}());
`;
}

const output = build();
if (process.argv.includes('--check')) {
	const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
	if (current !== output) {
		console.error('reste.js is out of date: run `npm run build`');
		process.exit(1);
	}
	console.log('reste.js is up to date');
} else {
	fs.writeFileSync(target, output);
	console.log('wrote reste.js (' + (output.length / 1024).toFixed(1) + ' kB, ' + output.split('\n').length + ' lines)');
}
