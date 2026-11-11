'use strict';

/**
 * The Backbone versions Alloy 3.x can be configured with (app/config.json "backbone"; 0.9.2 is Alloy's
 * default). The npm releases are byte-identical to the files Alloy ships, apart from the line that requires
 * underscore.
 */
const VERSIONS = ['0.9.2', '1.1.2', '1.3.3', '1.4.0', '1.6.0'];

function load(version) {
	return require('backbone-' + version);
}

/** Runs `define(Backbone, version)` once per supported Backbone version. */
function eachBackbone(define) {
	VERSIONS.forEach(version => define(load(version), version));
}

/** A stand-in for the Alloy global: just the registries RESTe fills. */
function installAlloy(Backbone) {
	global.Alloy = { Collections: {}, Models: {}, Backbone };
	global.Backbone = Backbone;
	return global.Alloy;
}

function uninstallAlloy() {
	delete global.Alloy;
	delete global.Backbone;
}

/** Records the events an object triggers: recorder.names, recorder.count('change'). */
function record(target) {
	const names = [];
	target.on('all', name => names.push(name));
	return {
		names,
		count: name => names.filter(item => item === name).length,
		clear: () => names.splice(0, names.length)
	};
}

module.exports = { VERSIONS, load, eachBackbone, installAlloy, uninstallAlloy, record };
