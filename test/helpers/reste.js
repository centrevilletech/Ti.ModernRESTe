'use strict';

/**
 * Which build the suite runs against: the sources (default), the single file users drop into app/lib
 * (RESTE_ENTRY=bundle) or the two-file build (RESTE_ENTRY=split). `npm test` runs all three.
 */
const path = require('path');

const ENTRIES = {
	bundle: path.join(__dirname, '..', '..', 'reste.js'),
	split: path.join(__dirname, '..', '..', 'split', 'reste.js')
};
const entry = ENTRIES[process.env.RESTE_ENTRY] || path.join(__dirname, '..', '..', 'src', 'index.js');

module.exports = require(entry);
module.exports.entry = entry;
