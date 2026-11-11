'use strict';

const Reste = require('./reste');
const { installFakeTi, wait, until } = require('./ti');

/**
 * A configured instance on a fresh fake Titanium.
 *   const { api, ti } = setup({ methods: [...] });
 */
function setup(config, tiOptions) {
	const ti = installFakeTi(tiOptions);
	const api = new Reste();
	if (config !== false) {
		api.config(Object.assign({ url: 'https://api.test/v1/' }, config));
	}
	return { api, ti, Reste };
}

/** The error a promise rejects with; fails when it resolves. */
async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error('expected a rejection');
}

module.exports = { setup, rejection, wait, until, Reste };
