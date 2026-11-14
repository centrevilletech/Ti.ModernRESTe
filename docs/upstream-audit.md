# Notes on upstream RESTe

These notes are a reading of upstream RESTe made before this fork changed
anything. They are a map of the work, not a criticism of the library: RESTe
has carried production apps for years, and most of what is listed here only
matters at a size, or under conditions, that it was never asked to handle when
it was written.

What was read: upstream's `reste.js` at its master
(`e54b51d`, 592 lines, `package.json` 1.7.0), its history since the last npm
release (1.6.0, November 2021), its 47 issues and 33 pull requests, and how it
attaches to Alloy and Backbone.

## Since the last npm release

Master has four functional changes that npm users do not have:

- bodies are sent with `PATCH` and `DELETE`, not only `POST` and `PUT`;
- `patch:` is recognised in a method definition;
- `expects` looks in `params.body` for every verb, not only `POST`;
- a `beforeSend` / `beforePost` hook can answer `{ skip: true }` to stop a
  request (pull request 78).

The open pull request 80 (and issue 79) proposes moving collections from
`Alloy.Collections` to `reste.Collections` so the library works outside
Titanium; it has no implementation of the HTTP side and its tests cannot run.
This fork keeps `Alloy.Collections`, also exposes `api.collections`, and takes
Backbone and the HTTP client by injection (`config.Backbone`,
`config.httpClient`), which is what makes the Node test suite possible.

## How it attaches to Alloy

- `Backbone` and `_` are globals that Alloy's `app.js` defines; RESTe uses
  both.
- With `models` in the config, `Backbone.sync` is **replaced** by a function
  that looks up `reste.modelConfig[model._type]`.
- For each collection in a model's config, `Alloy.Collections[name]` is created
  as a plain `Backbone.Collection` (or adopted if it exists) and tagged with
  `_type`, `_name` and the model class.
- Alloy 3.x ships Backbone 0.9.2 (the default), 1.1.2, 1.3.3, 1.4.0 and 1.6.0,
  chosen by `"backbone"` in `app/config.json`. They differ where RESTe touches
  them: 0.9.2 has no `Collection#set`, resets on fetch, does not fire `sync`
  after a fetch, has no `patch`, and reports what a save changed in
  `options.changes`.
- Alloy's data binding re-renders a bound view on each of
  `fetch destroy change add remove reset` (plus `sort` on 1.x). On Backbone
  1.x a fetch of N new rows is therefore N renders.

## What it does well

- One small file, no dependencies, dropped into `app/lib`.
- A declarative config: an endpoint is a name, a verb and a URL template.
- Collections for Alloy's data binding without model files, and a `transform`
  per model.
- Hooks at the right places (`beforeSend`, `onLoad`, `onError` globally and per
  method), and a `retry` function handed to the error handler.

All of that is kept.

## What this fork changed

Each has a test; the file is under `test/unit/` unless stated.

### Requests

| # | Upstream | In this fork | Test |
| --- | --- | --- | --- |
| 1 | With `config.Q` the promise is not returned: a deferred is created, but both branches `return makeHttpRequest(...)` before `return deferred.promise` (issue 74, since pull request 73) | every call returns a native promise | `compat`: "gives promises without Q" |
| 2 | The response text is parsed twice: `isJSON()` parses to test, `parseJSON()` parses again | parsed once | `requests`: "parses the response text once" |
| 3 | `while (url.indexOf('<' + param + '>') >= 0)` never ends when a value contains its own placeholder | templates are split once and joined | `url`: "does not loop when a value contains its own placeholder" |
| 4 | Path values are inserted unencoded | encoded; `encodeParams: false` opts out | `url`, `requests` |
| 5 | A missing placeholder is sent as a literal `<id>`; with `autoValidateParams` a string is thrown synchronously | the call rejects with `kind: 'params'` | `requests`: "rejects, and never throws" |
| 6 | Parameters that are not placeholders are dropped: no query strings (issue 5) | `query` in params, options and method definitions | `requests`, `url` |
| 7 | `expects` uses truthiness (`0`, `false`, `''` are "missing"), throws a string, and is a `TypeError` without params | presence check, rejection | `compat`: "expects and parameter validation" |
| 8 | `method(onLoad, onError)` makes the *error* callback the success callback | both forms recognised | `compat`: "method(onLoad, onError) keeps the two apart" |
| 9 | Header state is one list on the instance; per-request headers require mutating it before each call | headers resolved per request from defaults, method and call | `requests`: "layers default, method and call headers" |
| 10 | Function header values are called twice (once to set, once to log), and logged | called once; the log redacts | `requests`, `pipeline`: "never prints credentials" |
| 11 | `changeRequestHeader({ a, b })` only applies the first key | all keys | `requests` |
| 12 | `args.url.indexOf('http') == 0` treats a relative path such as `httpstatus/200` as absolute | scheme test | `url`, `requests` |
| 13 | Global headers are sent to methods with a full URL although the README says they are not: a bearer token reaches a storage or maps host | default headers go to the base URL's origin only; `globalHeaders: true` per method opts in | `requests`: "default headers stay on the API's origin" |
| 14 | `clearCookies` is defined inside the first request and closes over that request's client | defined on the instance | `requests` |
| 15 | `config()` requires `methods`; a second `config()` throws "already defined" | optional; reconfigurable | `requests`: "configuration" |
| 16 | No body can be sent except JSON or a flat form: a `Ti.Blob` is `JSON.stringify`-ed (issues 34, 43, 72) | multipart, with flattening of arrays and nested fields | `upload`, integration |
| 17 | `securityManager` is assigned after the client was created; it is creation-only on Android | passed at creation | `requests`: "passes TLS and client options" |
| 18 | The README's example sets `validatesSecureCertificate: false` | not in the README; a debug warning when set | `pipeline` |
| 19 | Errors: without `errorsAsObjects` the caller gets the body only, so no status, and nothing at all for a network failure; a warning is logged on every error | `ResteError`; `errorsAsObjects` defaults to true | `errors`, `compat` |
| 20 | An error without any handler is passed to the **success** callback; without a callback a string is thrown inside the HTTP callback | logged; the promise rejects; `errorsToOnLoad` opts back in | `compat` |
| 21 | A method's `onError` replaces the caller's and receives the success callback as its second argument although the README documents `(e, callback, globalOnError)`; the `retry` function is lost | precedence kept; third argument is `retry` | `compat` |
| 22 | `retry()` re-runs the request with the body `beforeSend` already transformed, and the client it creates cannot be aborted by the caller | re-runs from the original params; returns a handle | `compat`: "hooks see the original body again" |
| 23 | `beforePost` and `beforeSend` are exclusive for a POST; the README says both run | both run | `compat` |
| 24 | `{ skip: true }` calls `onLoad` without checking that there is one: a `TypeError` when the call was made without a success callback (with one, it works) | the value goes to the callback if there is one, and resolves the promise | `compat`: "{ skip: true } stops the request" |
| 25 | A string body is JSON-encoded | sent as it is | `requests` |
| 26 | `log(args.params)` prints `[object Object]`; debug logs bodies and tokens | structured, redacted | `pipeline` |
| 27 | No way to cancel before the request is sent, or a retried one; a timeout and a dropped connection cannot be told apart | `abort()` at any point; `kind` | `abort`, `errors` |

### Models and collections

| # | Upstream | In this fork | Test |
| --- | --- | --- | --- |
| 28 | `Backbone.sync` is replaced for the whole app | scoped `sync` per model class and collection | `sync`: "leaves Backbone.sync alone" |
| 29 | A second instance with models replaces the first one's `Backbone.sync`. A fetch of the first instance's collection then looks its model up in the second instance's config, finds nothing, and does nothing at all: no request, no `success`, no `error`; a model `save` of the first instance throws a `TypeError` (issues 12, 53) | instances are independent | `sync`: "two instances with models do not break each other" |
| 30 | `beforeCreate` is called on delete and `beforeDelete` on create | each on its own operation | `sync`: "create: ... runs beforeCreate" |
| 31 | `if (e.code > 200) onError(e)` on success responses: a body with a `code` field is an error, and `onError` may be `null` | the HTTP status decides | `sync`: "does not mistake a code field" |
| 32 | `item.id = item[modelConfig.id]` overwrites a real `id` with `undefined` when the model has no `id` setting, and mutates the response | `idAttribute`; the copy only when ids differ | `sync`: "does not overwrite id" |
| 33 | The id is substituted as `params[modelConfig.id]` only, so the README's `locations/<id>` with `id: 'objectId'` sends a literal `<id>` | both `<id>` and `<attribute>` are filled | `sync`: "update: PUTs to the id" |
| 34 | A collection whose config is not found is `undefined.read` (issue 64); a response without the `content` key is `response.forEach is not a function`; a `null` response never settles | `kind: 'config'` / `'parse'` errors | `sync`: "fails cleanly" (three tests) |
| 35 | A model without `update` / `delete` configured is `reste[undefined](...)` | `kind: 'config'` | `sync` |
| 36 | `sync` is triggered by RESTe and again by Backbone 1.x | once | `sync`: "fires sync once" |
| 37 | `fetch` errors do not reach the `error` option in several paths (issue 77) | always | `sync` |
| 38 | `{ patch: true }` is ignored; on Backbone 0.9.2 a save with no changes sends `{}` | `patch` method and attributes; full body when nothing changed | `sync` |
| 39 | `model.read` with `content` configured and absent is a `TypeError` | falls back to the body | `sync`: "read" |
| 40 | Paging metadata is discarded: only `response[content]` reaches the collection (issue 40) | `collection.meta`, `collection.paging`, pagers | `pagination`, `merge` |
| 41 | Every fetch rebuilds the collection: model identity is lost and a bound list is rendered per row on Backbone 1.x | merge in place, one render | `merge` |
| 42 | `createModel` returns a bare `Backbone.Model` and `createCollection` returns nothing, although the README says both return their object | the configured class; the collection | `sync` |

### Found on devices

| # | Finding | Handling | Check |
| --- | --- | --- | --- |
| 43 | Titanium's Android HTTP client sends `DELETE` without its body (SDK 13.4.1), so upstream master's "send DELETE bodies" has no effect there | documented; a log line the first time it happens | example: "DELETE without a body ..." |
| 44 | iOS answers a conditional request whose server reply is 304 with the stored 200 | a 200 carrying the validator that was sent counts as not modified | `cache`; example: "ETag" |
| 45 | Android fires a send-stream event every few hundred bytes (6145 for 3 MB) | progress is reported in steps | `upload`; example: "upload progress" |
| 46 | Android does not keep the order of multipart fields | documented | example: "multipart upload" |

### Compatibility checked mechanically

`test/differential/` runs 62 scenarios from upstream's README against upstream
(read out of this repository's history) and against this build, on Backbone
0.9.2, 1.4.0 and 1.6.0, and compares the callbacks called, their arguments and
the requests sent. `test/unit/differential.test.js` fails when a scenario
differs without being listed there with its reason, and when a listed one no
longer differs. That is how the README's migration table is kept complete.

## Additions

Not in upstream, and added here: per-request options; a timeout per call (upstream has one per method); status
hooks; a retry policy (upstream hands the error handler a manual `retry()`);
idempotency keys; a cache and conditional requests; pagination; upload and
download progress; interceptors; a way to drop late responses after sign-out;
de-duplication; type declarations; a test suite. Each is described in the
README.

## Worth offering upstream

Items 1, 2, 3, 8, 30, 31, 32 and 36 are small, self-contained and
uncontroversial; they can be offered to upstream as individual pull requests
against its single file without any of this fork's structure.
