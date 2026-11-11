# Changelog

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
  refresh)
- Retry policy: exponential back-off with jitter, `Retry-After`, only for
  requests that are safe to repeat
- Idempotency keys: per call, reused across retries; per named user action
- HTTP cache: ETag / `If-None-Match`, `Cache-Control`, ttl,
  stale-while-revalidate, stale-if-error, invalidation, memory with LRU
  eviction, optional persistent store (`Reste.fileStore`,
  `Reste.propertiesStore`)
- Pagination: page / per_page and cursor styles with configurable extractors;
  `api.paginate()`; `fetchNext()`, `fetchPrevious()`, `refresh()`, `hasMore()`,
  `paging` and `meta` on collections
- Collections merged in place on every Backbone version Alloy ships:
  `fetch({ merge: true })`, `upsert()`, chunked merges, one render of a bound
  list per merge, no work when nothing changed
- `identity`: one model instance per id across collections; `api.model()`
- Optimistic `save`, `destroy` and `create` with rollback;
  `model.optimistic()` and `collection.optimistic()` for any request
- `api.list()`: a filtered, paginated list that follows a collection
- Multipart uploads with `Ti.Blob` / files and mixed fields, upload and
  download progress (reported in steps), download to a file
- Interceptors (`request`, `response`, `error`), globally, per method, per call
- `session.reset()`: responses of the previous session are dropped
- In-flight de-duplication of identical GETs
- A debug logger that redacts credentials; `logger` and `redact` options
- `request()`, `use()`, `abortAll()`, `removeMethod()`, `hasMethod()`,
  `getRequestHeaders()`, function URLs, `{ method, url }` definitions, `head`
- TypeScript declarations
- A test suite, a benchmark against upstream, an example app with on-device
  checks

### Changed

- Sync is scoped to RESTe's models and collections; `Backbone.sync` is no
  longer replaced
- `errorsAsObjects` defaults to `true`, as 1.x announced
- Path values are URI-encoded (`encodeParams: false` to opt out)
- A missing path parameter rejects the call instead of being sent as `<name>`
- An error with no handler is logged instead of being passed to the success
  callback (`errorsToOnLoad: true` to opt back in)
- `beforePost` and `beforeSend` both run for a POST, as documented
- A string body is sent as it is
- `destroy()` sends no body unless `beforeDelete` returns one
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
- `changeRequestHeader` ignored all but the first key
- Header functions were called twice, and their values logged

See [docs/upstream-audit.md](docs/upstream-audit.md) for each of these with
the test that covers it.
