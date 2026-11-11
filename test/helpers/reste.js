'use strict';

/**
 * Which build the suite runs against: the sources (default) or the single-file bundle users drop into
 * app/lib (RESTE_ENTRY=bundle). `npm test` runs both.
 */
const path = require('path');

const entry = process.env.RESTE_ENTRY === 'bundle'
	? path.join(__dirname, '..', '..', 'reste.js')
	: path.join(__dirname, '..', '..', 'src', 'index.js');

module.exports = require(entry);
module.exports.entry = entry;
