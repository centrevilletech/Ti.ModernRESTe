/**
 * Four small screens, one per thing RESTe does for an app:
 *   Things  a collection bound to a TableView, refreshed in place; create / update / delete, optimistic
 *   Items   a paginated list: fetch(), fetchNext(), refresh()
 *   Upload  multipart upload with progress and cancellation, download to a file
 *   Checks  the on-device checks (lib/checks.js), also run at launch when `reste.autorun` is set
 */
const api = Alloy.Globals.api;
const checks = require('checks');
const things = Alloy.Collections.things;
const items = Alloy.Collections.items;

let renders = 0;
let uploading = null;

// ---------------------------------------------------------------- Things

function transformThing(model) {
	renders++; // one call per row per render: shows how often the bound list is rebuilt
	const data = model.toJSON();
	data.label = data.name + '   ×' + (data.count || 0);
	return data;
}

function showThings(text) {
	$.thingsStatus.text = things.length + ' things · ' + text;
}

function loadThings() {
	const before = renders;
	things.fetch().then((result) => {
		showThings(result.unchanged ? 'unchanged: nothing parsed, nothing rendered'
			: '+' + result.added.length + ' ~' + result.changed.length + ' -' + result.removed.length + ' · ' + (renders - before) + ' rows rendered');
	}, error => showThings('failed: ' + error.message));
}

function onRefreshThings() {
	loadThings();
}

function onAddThing() {
	things.create({ name: 'Thing ' + (things.length + 1), count: 0 }, {
		optimistic: true,
		success: () => showThings('created'),
		error: (model, error) => showThings('create failed, taken out again: ' + error.status)
	});
}

function onAddBadThing() {
	// The server refuses a thing without a name: the optimistic row appears and is rolled back.
	things.create({ count: 0 }, {
		optimistic: true,
		error: (model, error) => showThings('refused (' + error.status + '), rolled back')
	});
}

function onThingClick(e) {
	const model = things.get(e.row.thingId);
	if (!model) {
		return;
	}
	model.save({ count: (model.get('count') || 0) + 1 }, { optimistic: true, patch: true }).then(
		() => showThings('saved'),
		error => showThings('save failed, rolled back: ' + error.message)
	);
}

// ---------------------------------------------------------------- Items

function transformItem(model) {
	const data = model.toJSON();
	data.label = '#' + data.id + '  ' + data.title;
	return data;
}

function showItems() {
	const paging = items.paging || {};
	$.itemsStatus.text = items.length + ' of ' + (paging.total || '?') + ' · page ' + (paging.page || 0) + '/' + (paging.lastPage || '?')
		+ (items.hasMore() ? '' : ' · end');
}

function onRefreshItems() {
	items.refresh().then(showItems, error => ($.itemsStatus.text = 'failed: ' + error.message));
}

function onMoreItems() {
	items.fetchNext().then(showItems, error => ($.itemsStatus.text = 'failed: ' + error.message));
}

// ---------------------------------------------------------------- Upload

function onUpload() {
	if (uploading) {
		return;
	}
	const buffer = Ti.createBuffer({ length: 2 * 1024 * 1024 });
	buffer.fill(65);
	$.uploadBar.value = 0;
	$.uploadStatus.text = 'uploading...';
	uploading = api.upload({ body: { file: buffer.toBlob(), caption: 'From the example app' } }, {
		onProgress(fraction) {
			$.uploadBar.value = fraction;
			$.uploadStatus.text = 'uploading ' + Math.round(fraction * 100) + '%';
		}
	});
	uploading.then((result) => {
		$.uploadStatus.text = 'uploaded ' + result.files.file.size + ' bytes';
	}, (error) => {
		$.uploadStatus.text = error.isCancelled ? 'cancelled' : 'failed: ' + error.message;
	}).then(() => {
		uploading = null;
	});
}

function onCancelUpload() {
	if (uploading) {
		uploading.abort();
	}
}

function onDownload() {
	const file = Ti.Filesystem.getFile(Ti.Filesystem.applicationCacheDirectory, 'example-download.bin');
	$.uploadBar.value = 0;
	api.download({ size: 500000 }, { file, onProgress: fraction => ($.uploadBar.value = fraction) }).then((saved) => {
		$.uploadStatus.text = 'downloaded ' + saved.size + ' bytes to ' + saved.name;
	}, error => ($.uploadStatus.text = 'failed: ' + error.message));
}

// ---------------------------------------------------------------- Checks

function onRunChecks() {
	$.checksLog.text = '';
	$.checksSummary.text = 'running...';
	const lines = [];
	checks.run({
		table: $.thingsTable,
		renders: () => renders,
		onLine(line) {
			lines.push(line);
			$.checksLog.text = lines.join('\n');
		}
	}).then((summary) => {
		$.checksSummary.text = summary.pass + ' passed, ' + summary.fail + ' failed';
	});
}

$.tabs.addEventListener('open', () => {
	if (Ti.App.Properties.getBool('reste.autorun', false)) {
		$.tabs.activeTab = 3;
		onRunChecks();
	} else {
		loadThings();
		onRefreshItems();
	}
});

$.tabs.open();
