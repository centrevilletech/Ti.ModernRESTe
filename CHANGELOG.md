# Changelog

## Unreleased

### Added

- `api.list({ collection, load })`: a list whose pages come from a function
  of the app (a service call) instead of a method, over RESTe's collections
  or any Backbone collection
- `api.upsert(collection, items)`, `api.replace(model, attributes)` and
  `api.optimistic(target, attributes, send)`: the collection and model
  helpers as functions, also for models and collections the app created
  itself

- A custom `logger` gets the facts of every line about a request as its
  third argument (`event`, `endpoint`, `method`, `url`, `attempt`, `status`,
  `kind`, `elapsed`, `duration`, `delay`, `fromCache`): enough to print a line
  in an app's own format, one per exchange, or to keep request timings

### Changed

- `mapError` is also asked about cancelled and stale requests, so a call
  rejects with the app's own error class whatever happened to it. Callbacks,
  hooks and `config.onError` still never hear of such a request

### Fixed

- A response with no freshness left and no validator (`ttl: 0`, or the
  `'etag'` policy, answered without an `ETag`) was kept, and persisted,
  although it could never be served again

- Rolling back an optimistic change removed an attribute whose value had been
  `null` (Backbone's `has()` is false for it) instead of restoring the `null`

- A status hook that calls `session.reset()` no longer turns the answer that
  fired it into a stale request: its caller gets the status it was answered
  with, and only what is still on its way is dropped

## 2.0.0 — 2026-11-11

The first release of this fork. It continues from upstream RESTe at its
master (1.7.0 in `package.json`, never published; the last npm release is
1.6.0). A 1.x config keeps working; the README has a migration table for the
places where behaviour changed.

### Added

- A promise from every call, with `abort()` and the call's idempotency key;
  callbacks still work, and `config.Q` is no longer needed
- Per-request `headers`, `query`, `timeout`, `deadline`, `signal`, `retry`,
  `cache` and more as a second argument; nothing is shared between concurrent
  calls
- Query strings from objects (arrays, nested objects, nulls left out), with
  configurable array format
- `ResteError`: kind (`http`, `network`, `timeout`, `cancelled`, `stale`,
  `parse`, `params`, `config`), status, parsed body, headers, `Retry-After`;
  `mapError` to turn it into an app's own error class
- `onStatus` hooks that fire once per event and can answer `'retry'` (token
  refresh): every request is sent again after a 401 (`authStatuses`), only
  repeatable ones after any other status
- Retry policy: exponential back-off with jitter, `Retry-After`, only for
  requests that are safe to repeat (GET / HEAD, a request with an idempotency
  key, a method defined with `retry`); nothing at the call site can make an
  unsafe request repeatable
- Idempotency keys: per call, reused across retries; per named user action
- HTTP cache: ETag / `If-None-Match`, `Cache-Control`, `Vary`, ttl,
  stale-while-revalidate, stale-if-error, memory with LRU eviction, optional
  persistent store (`Reste.fileStore`, `Reste.propertiesStore`), a `scope` per
  user; invalidation that also covers requests in flight and entries a
  previous launch persisted; only the body and four headers are persisted, and
  nothing that varies on a credential header
- Pagination: page / per_page and cursor styles with configurable extractors;
  `api.paginate()`; `fetchNext()`, `fetchPrevious()`, `refresh()`, `hasMore()`,
  `paging` and `meta` on collections
- Collections merged in place on every Backbone version Alloy ships:
  `fetch({ merge: true })`, `upsert()`, chunked merges, one render of a bound
  list per merge, no work when nothing changed
- `identity`: one model instance per id across collections, held weakly
  where the engine has `WeakRef` and bounded otherwise; `api.model()`
- Optimistic `save`, `destroy` and `create` with rollback;
  `model.optimistic()` and `collection.optimistic()` for any request; a list
  response requested before an optimistic write does not undo it
- `api.list()`: a filtered, paginated list that follows a collection
- Multipart uploads with `Ti.Blob` / files and mixed fields, upload and
  download progress (reported in steps), download to a file
- Interceptors (`request`, `response`, `error`), globally, per method, per call
- `session.reset()`: responses of the previous session are dropped, requests
  waiting to be retried are not sent with the next session's credentials, and
  the cache, identity maps and paging state start over
- In-flight de-duplication of identical GETs
- A debug logger that replaces the values of headers, body fields, query
  parameters and path placeholders whose name looks like a credential;
  `logger` and `redact` options
- `request()`, `use()`, `abortAll()`, `removeMethod()`, `hasMethod()`,
  `getRequestHeaders()`, `inspect()`, function URLs, `{ method, url }`
  definitions, `head`
- TypeScript declarations
- A test suite (including 62 scenarios from upstream's README run side by
  side against upstream and this build), a mutation check, a benchmark against
  upstream, an example app with on-device checks

### Changed

- Sync is scoped to RESTe's models and collections; `Backbone.sync` is no
  longer replaced
- `errorsAsObjects` defaults to `true`, as 1.x announced; `error.url` is the
  full URL
- Path values are URI-encoded (`encodeParams: false` to opt out)
- A missing path parameter rejects the call instead of being sent as `<name>`;
  so does an empty string in the path (not in the query string)
- An error with no handler is logged instead of being passed to the success
  callback (`errorsToOnLoad: true` to opt back in; with `errorsAsObjects:
  false` the 1.x behaviour stays)
- Default headers are sent to the base URL's origin only; a method with a full
  URL elsewhere opts in with `globalHeaders: true`
- An empty response body is `null`, not `''`; invalid JSON served as JSON is
  an error
- Nested values of a form-encoded body are flattened to `name[child]`
- `beforePost` and `beforeSend` both run for a POST, as documented
- A string body is sent as it is
- `destroy()` sends no body unless `beforeDelete` returns one, and a DELETE
  without a body sends none (upstream master sent `{}`; 1.6.0 did neither)
- A call returns a promise with `abort()` instead of the HTTP client
- A JSON body gets `Content-Type: application/json` when no content type is set
- Method definitions are analysed on first call; `config()` can be called again
- The security manager is passed when the HTTP client is created

### Fixed

- Promises: the code that returned the promise was unreachable
- The response text was parsed twice
- A path value containing its own placeholder never returned
- `method(onLoad, onError)` used the error callback for success
- The legacy `retry()` ran `beforeSend` on its own output
- `clearCookies` only existed after the first request
- A relative URL starting with "http" was treated as absolute
- `expects` treated `0`, `false` and `''` as missing, and threw
- `beforeCreate` ran on delete and `beforeDelete` on create
- A successful response with a `code` field above 200 was treated as an error
- `item.id` was overwritten with `undefined` for models without an `id` setting
- The model id was only substituted under the configured attribute name
- A missing read / update / delete method, or a response without the
  configured `content`, was a `TypeError`
- `sync` fired twice per fetch on Backbone 1.x
- A second instance with models broke the first
- Models whose `id` setting names another attribute: unchanged from 1.x (the
  model's id is `id`, the configured attribute is copied into it), and now
  also when a model is made or added with only that attribute
- A header function, `beforeSend` / `beforePost` hook or interceptor that
  throws rejects the call instead of throwing out of it (or, on a retry, out
  of a timer)
- `changeRequestHeader` ignored all but the first key
- Header functions were called twice, and their values logged

See [docs/upstream-audit.md](docs/upstream-audit.md) for each of these with
the test that covers it.
