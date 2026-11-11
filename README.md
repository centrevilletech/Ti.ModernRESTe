# RESTe

A REST / API helper for Titanium with Alloy models and collections: describe
your endpoints once, get a method per endpoint, and bind lists to collections
that load themselves.

This is a maintained fork of [RESTe](https://github.com/jasonkneen/RESTe) by
Jason Kneen. It is still one file with no dependencies, `require('reste')`
still returns the same constructor, and a 1.x config still works. What is new
is everything an app ends up writing around RESTe: promises, per-request
headers, typed errors, retries, idempotency keys, caching, pagination, uploads
with progress, cancellation, and collections that update in place instead of
being rebuilt.

```javascript
const Reste = require('reste');
const api = new Reste();

api.config({
    url: 'https://api.example.com/v1/',
    requestHeaders: { Accept: 'application/json', Authorization: () => 'Bearer ' + session.token },
    retry: true,
    methods: [
        { name: 'getArticles', get: 'articles', paginate: 'page' },
        { name: 'getArticle', get: 'articles/<id>' },
        { name: 'createArticle', post: 'articles', idempotent: true }
    ]
});

const article = await api.getArticle({ id: 42 });                       // a promise ...
api.getArticle({ id: 42 }, article => show(article), error => warn(error)); // ... or callbacks, as before
```

## Why this fork exists

RESTe's last npm release is 1.6.0 from 2021. It still works for simple calls,
but anything beyond them has to be built around it, and some of what it does
is wrong in ways that only show up in production:

- **Promises never worked after 1.5.x.** `config.Q` creates a deferred, but
  every code path returns the HTTP client before the line that returns the
  promise. The usual workaround is to wrap every call by hand.
- **It replaces `Backbone.sync` for the whole app.** A second RESTe instance
  breaks the first one's models, and any other Backbone model in the app goes
  through RESTe.
- **Headers are one shared list**, sent to every URL including third-party
  ones. Per-request headers mean changing the defaults right before a call and
  relying on them being read synchronously.
- **The response is parsed twice** (once to test whether it is JSON, once for
  the value), and every list fetch rebuilds the collection: with Backbone 1.x
  an Alloy `dataCollection` view is rendered once per row.
- **A path value is put into the URL as it is**, a missing one is sent as a
  literal `<id>`, and a value that contains its own placeholder never returns.
- **Model sync has copy-paste bugs**: `beforeCreate` runs on delete and
  `beforeDelete` on create, a response with a `code` field above 200 is an
  error, `item.id` is overwritten with `undefined` when no id is configured.
- No status code on errors by default, no query strings, no multipart, no
  cancellation of a retried request, no paging metadata, no cache.

The full list, with the test that covers each fix, is in
[docs/upstream-audit.md](https://github.com/centrevilletech/Ti.ModernRESTe/blob/HEAD/docs/upstream-audit.md).

## What changed

| Area | 1.x | 2.0 |
| --- | --- | --- |
| Calls | callbacks; promises broken | a promise from every call, callbacks still supported, `abort()` on the returned handle |
| Headers | one shared list | defaults + per method + per call, resolved for each request |
| Parameters | raw substitution, silent on missing ones | encoded, a missing one rejects; query strings from objects (arrays, nested, nulls) |
| Bodies | JSON or form | JSON, form, multipart with `Ti.Blob` / files, raw strings; upload and download progress |
| Errors | body only (or the HTTP client's event) | one `ResteError`: status, parsed body, headers, kind (`http`, `network`, `timeout`, `cancelled`, `stale`, `parse`, `params`), `mapError` for your own error class |
| Retries | a `retry()` function handed to `onError` | a policy: back-off with jitter, `Retry-After`, only for requests that are safe to repeat; idempotency keys |
| Caching | none | ETag / `If-None-Match`, `Cache-Control`, per-endpoint policy, stale-while-revalidate, memory and optional persistent store |
| Lists | the list, metadata dropped | page and cursor pagination that keeps the server's metadata; `fetchNext()`, `refresh()` |
| Collections | reset on every fetch; global `Backbone.sync` | scoped sync; merge in place (same model instances, change events only for changed attributes, one render per merge); one model per id across collections; optimistic updates with rollback |
| Lifecycle | none | session reset drops late responses; in-flight de-duplication; interceptors; status hooks that fire once per event; redacting debug log |

Measured against upstream master (see [Performance](#performance)): a 500-item
list is handled about 1.5 times faster, a collection that did not change 4 to
9 times faster, and a bound list is rendered once per update instead of once
per row. What got slower: a single small request costs 3 to 4 microseconds
more than before, and defining and first calling methods about a millisecond
more per app start.

## Install

Tested on Titanium SDK 13.4.1.GA with Alloy 3.0.1. The code needs an ES2015
JavaScript engine, so older SDKs back to 9 should work but were not tried. Any
Backbone version Alloy offers is supported: 0.9.2, 1.1.2, 1.3.3, 1.4.0, 1.6.0. Models
and collections need Alloy (or any Backbone passed as `config.Backbone`); plain
requests need neither.

Copy [`reste.js`](https://github.com/centrevilletech/Ti.ModernRESTe/blob/HEAD/reste.js) into `app/lib/`, or install it from npm in
`app/lib`:

```bash
cd app/lib && npm install @centrevilletech/reste
```

```javascript
const Reste = require('reste');                    // the file in app/lib
const Reste = require('@centrevilletech/reste');   // the npm package
```

TypeScript declarations are in `reste.d.ts`: `new Reste<{ getArticles: Article[] }>()` types the methods you name
and makes a misspelt one an error; without the type argument every name is a
method.

Configure it in `alloy.js`, or in a lib file required from there: Alloy
resolves `dataCollection` when a view is created, so the collections have to
exist first.

## Calling methods

```javascript
api.method(params, options)                        // -> promise
api.method(params, onLoad, onError, options)       // callbacks; the promise is returned as well
api.method(onLoad, onError)                        // no params
api.request('method', params, options)             // by name
api.request({ get: 'health' })                     // a one-off request
```

`params` holds the values for `<placeholders>` in the URL, plus two reserved
keys:

```javascript
api.updateArticle({
    id: 42,                                        // articles/<id>
    query: { notify: true, tags: ['a', 'b'] },     // ?notify=true&tags[]=a&tags[]=b
    body: { title: 'New title' }                   // the JSON body
});
```

`options` (all optional):

| Option | Meaning |
| --- | --- |
| `headers` | headers for this call; a value of `null` removes a default header |
| `query` | merged over `params.query` and the method's `query` |
| `timeout` | milliseconds for this call |
| `deadline` | total milliseconds including retries; ends as a timeout |
| `signal` | an abort signal: `api.createAbortController().signal` |
| `retry` | `false`, `true`, a number of retries or a policy, for this call |
| `idempotencyKey` | the key to send |
| `action` | names the user action: the same payload keeps its key until it succeeds |
| `cache` | `'reload'` (skip the cached copy, refresh it) or `'no-store'` (bypass); `force: true` is `'reload'` |
| `dedupe` | share (or do not share) an identical GET that is in flight |
| `fullResponse` | resolve with the response object instead of the data |
| `onProgress` | `fraction => ...`, 0 to 1: upload progress for requests with a body, download progress otherwise |
| `progressStep` | smallest progress change to report (default 0.01) |
| `file` | downloads: the `Ti.Filesystem.File` (or path) to write to |
| `onUpdate` | stale-while-revalidate: called when the background refresh brought new data |
| `interceptors` | `{ request, response, error }` for this call |
| `meta` | anything; handed to interceptors, hooks and `mapError` as `request.meta` |

What a call returns is a promise with two additions: `abort()` (also
`cancel()`) and `idempotencyKey`.

The promise resolves with the response data. With `fullResponse: true` (per
call, per method or in the config) it resolves with the response:

```javascript
const response = await api.getArticles({}, { fullResponse: true });
response.status        // 200
response.data          // the body after `unwrap`
response.body          // the parsed body as the server sent it
response.meta          // the value at the `meta` path
response.header('X-Request-Id'), response.headers, response.etag
response.fromCache, response.stale, response.notModified
response.attempts, response.duration, response.idempotencyKey
```

Callbacks receive `(data, response)`.

## Configuration

`api.config(options)`; calling it again replaces the configuration.

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | | base URL; `setUrl()` / `getUrl()` change and read it |
| `timeout` | `10000` | milliseconds |
| `requestHeaders` | | default headers; a value may be a function, called for every request |
| `methods` | `[]` | [method definitions](#method-definitions) |
| `models` | `[]` | [model definitions](#models-and-collections) |
| `unwrap`, `meta` | | where the data and the metadata are in a response body: `unwrap: 'data', meta: 'meta'` for `{ data, meta }` envelopes. A body without that key is passed as it is |
| `fullResponse` | `false` | resolve with the response object |
| `mapError` | | `(error, request) => yourError`: what calls reject with |
| `onStatus` | | hooks by HTTP status, see [Status hooks](#status-hooks) |
| `authStatuses` | `[401]` | statuses after which a hook's `'retry'` may re-send any request |
| `interceptors` | | `{ request, response, error }`, see [Interceptors](#interceptors) |
| `retry` | off | `true` or a [policy](#retries) |
| `idempotency` | | `{ header: 'Idempotency-Key', methods: ['POST'], generate }` |
| `cache` | | `{ store, maxEntries: 100, defaults, scope }`, see [Caching](#caching) |
| `dedupe` | `false` | identical GETs in flight share one request |
| `pagination` | | defaults for paginated methods |
| `failWhenOffline` | `false` | reject at once when `Ti.Network.online` is false |
| `methodOverride` | off | send a method the platform cannot send with its body as POST plus a header, see [Method override](#method-override) |
| `progressStep` | `0.01` | smallest change in upload / download progress that is reported |
| `query` | | `{ arrayFormat: 'brackets' \| 'repeat' \| 'indices' \| 'comma', nulls: 'skip' \| 'empty', skipEmptyString }` |
| `querySerializer` | | `query => string`, replaces the built-in serializer |
| `encodeParams` | `true` | encode path values |
| `debug` | `false` | `true`: log requests; `'verbose'`: headers and bodies too |
| `logger`, `redact` | | see [Logging](#logging) |
| `identity`, `chunk`, `events`, `changeEvent` | | defaults for [collections](#models-and-collections) |
| `securityManager`, `clientOptions`, `validatesSecureCertificate` | | see [TLS](#tls) |
| `onLoad`, `onError`, `beforeSend`, `beforePost` | | the 1.x hooks, see [Hooks from 1.x](#hooks-from-1x) |
| `errorsAsObjects`, `errorsToOnLoad` | `true`, `false` | 1.x error delivery, see [Migrating](#migrating-from-reste-1x) |

Instance members: `config`, `setUrl`, `getUrl`, `clearCookies`,
`setRequestHeaders`, `changeRequestHeader`, `removeRequestHeaderItem`,
`getRequestHeaders`, `addMethod`, `removeMethod`, `hasMethod`, `request`,
`use`, `paginate`, `list`, `upsert`, `replace`, `optimistic`, `session`,
`cache`, `idempotency`, `abortAll`, `createAbortController`, `addModel`,
`createModel`, `createCollection`, `model`, `collections`, `models`,
`identity`, `inspect`. A method may not be named after
one of the 1.x members (`config`, `setUrl`, ...); it may take one of the newer
names, and then hides that member on the instance.

Static members: `Reste.ResteError`, `Reste.createAbortController()`,
`Reste.fileStore()`, `Reste.propertiesStore()`, `Reste.version`.

## Method definitions

```javascript
{ name: 'getArticle', get: 'articles/<id>' }
{ name: 'search', method: 'POST', url: 'search' }                 // any HTTP method
{ name: 'push', post: 'https://push.example.com/send' }           // a full URL ignores the base URL (and gets no default headers)
{ name: 'regional', get: () => regionBase() + 'stores/<id>' }     // a function is evaluated per call
```

| Key | Meaning |
| --- | --- |
| `get`, `post`, `put`, `patch`, `delete`, `head` | the URL for that verb, with `<placeholders>` |
| `headers` (or `requestHeaders`) | headers for this method |
| `globalHeaders` | whether the default headers are sent. Default: yes for relative URLs and full URLs on the base URL's origin, **no** for other origins (a third party must not get your token); `true` / `false` overrule |
| `redact` | placeholders whose values are replaced in the debug log: `['code']` |
| `query` | query parameters sent with every call |
| `timeout`, `deadline` | per method |
| `expects` | names that must be present in the params or the body |
| `encodeParams: false` | send path values as given |
| `retry` | `true` or a policy: repeating this request is harmless whatever its verb; `false`: never retry it |
| `idempotent` | every call carries an idempotency key |
| `cache` | `true`, `'etag'`, a ttl in ms, or a policy |
| `invalidates` | methods whose cached responses are dropped when this one succeeds |
| `dedupe` | per method |
| `multipart` | send the body as multipart/form-data (automatic when the body holds a `Ti.Blob` or file) |
| `form` | send the body form-encoded |
| `download` | write the response to `options.file`, or resolve with the response blob |
| `responseType` | `'text'` (do not parse) or `'blob'` |
| `unwrap`, `meta`, `fullResponse` | per method; `unwrap: false` switches the envelope off |
| `paginate` | `'page'`, `'cursor'` or a config, see [Pagination](#pagination) |
| `session: false` | the request survives a session reset (sign-in, public configuration) |
| `methodOverride` | `true`, `false` or a policy for this method, see [Method override](#method-override) |
| `statusHooks: false` | `onStatus` hooks do not fire for this method (a wrong password is not an expired session) |
| `mapError`, `interceptors` | per method |
| `onLoad`, `onError`, `beforeSend`, `beforePost` | the 1.x hooks, per method |
| `clientOptions`, `securityManager` | per method |

Definitions are only stored by `config()`; a method is analysed the first time
it is called.

## Errors

Every failure is a `ResteError` (an `Error`):

```javascript
try {
    await api.createArticle({ body });
} catch (error) {
    error.kind         // 'http' | 'network' | 'timeout' | 'cancelled' | 'stale' | 'parse' | 'params' | 'config'
    error.status       // 422, or 0 when there was no response
    error.body         // the parsed body: { message: '...', errors: { title: [...] } }
    error.headers      // response headers, names lower-cased
    error.retryAfter   // Retry-After in milliseconds, or null
    error.attempts, error.endpoint, error.method, error.url, error.idempotencyKey
    error.isTimeout, error.isNetwork, error.isOffline, error.isCancelled, error.isHttp
}
```

| kind | when |
| --- | --- |
| `http` | the server answered outside 2xx |
| `network` | no response: refused, dropped, DNS, TLS. `isOffline` when the device reported no connectivity |
| `timeout` | no response within the timeout, or the deadline passed |
| `cancelled` | `abort()` or an abort signal |
| `stale` | the session was reset while the request was in flight; `isCancelled` is true as well |
| `parse` | the response said it was JSON and was not |
| `params` | a path parameter or an `expects` name is missing; `error.missing` lists them |
| `config` | the request could not be built: unknown method, a model without the method it needs |

A call never throws, and never calls back before it returned: a missing
parameter, a header function or a `beforeSend` hook that throws, an
interceptor that throws, all reject the returned promise (and reach the error
callback).

For code written against 1.x's `errorsAsObjects: true` the error also has
`code` (the status), `content` (the body), `error` (the platform's error
text), `success`, `type` and `url`.

### Your own error class

```javascript
api.config({
    mapError(error, request) {
        if (error.isHttp && error.body && error.body.code) {
            return new ApiError(error.body.code, error.body.message, error.body.errors, error);
        }
        return new ApiError(error.isTimeout ? 'TIMEOUT' : error.isOffline ? 'OFFLINE' : 'NETWORK', error.message, {}, error);
    }
});
```

Calls then reject with what the mapper returns (callbacks receive it too). An
error thrown by one of your interceptors reaches the mapper, and the caller,
untouched.

The mapper is also asked about a cancelled or stale request (`error.isCancelled`),
so a caller only ever catches one error class. No callback, hook or global
handler hears of such a request. Give your error an `isCancelled` that is true
for them: [lists that follow a collection](#lists-that-follow-a-collection)
read it to tell a cancellation from a failure.

## Retries

Off unless configured. `retry: true` uses the defaults:

```javascript
retry: {
    retries: 2,                    // sends after the first one
    baseDelay: 500, factor: 2, maxDelay: 8000, jitter: 0.25,
    methods: ['GET', 'HEAD'],      // verbs that may be repeated without a key
    statuses: [502, 503, 504],
    kinds: ['network', 'timeout'],
    retryAfter: true, maxRetryAfter: 30000,
    shouldRetry(error, attempt, request) {}   // true / false overrules the two lists above
}
```

The rule for what may be sent again, by a retry or by anything else in this
library:

1. A request is **repeatable** when it is a GET or HEAD, when it carries an
   idempotency key, or when its *method definition* says `retry: true` (or
   gives a policy): you have checked that this endpoint answers the same
   twice.
2. Only repeatable requests are retried. A POST that timed out is not sent
   again; the caller gets the timeout and decides.
3. Nothing at the call site changes that: `{ retry: 3 }` on a call makes a
   repeatable request more patient (or `{ retry: false }` stops it), it does
   not make a POST repeatable. `shouldRetry` cannot either.
4. A [status hook](#status-hooks) that answers `'retry'` re-sends repeatable
   requests after any status, and *any* request after a 401: a 401 means the
   server refused the request before doing anything with it. `authStatuses`
   (default `[401]`) lists the statuses your API uses that way.

Every attempt resolves the headers again (a refreshed token is used) and runs
the request interceptors again. `error.attempts` and `response.attempts` say
how often the request was sent. A request that is waiting for its next
attempt when the session is reset is dropped, not sent with the next user's
credentials.

## Idempotency keys

```javascript
{ name: 'createOrder', post: 'orders', idempotent: true }
```

Each call gets one key, sent as `Idempotency-Key` and reused by every retry of
that call. It is on the returned handle (`handle.idempotencyKey`), on the
response and on the error.

When the *user* repeats an action (Retry after a timeout, the form unchanged),
the server should see the same key again. Name the action:

```javascript
api.createOrder({ body: order }, { action: 'place-order' });
```

The same action with the same payload keeps its key until it succeeds or the
server gives a definite refusal (a 4xx other than 408, 409, 425, 429); a
changed payload gets a new key. `api.idempotency.key(action, payload)` and
`.done(action)` do the same by hand.

## Caching

GET only, per method:

```javascript
{ name: 'getCatalog', get: 'catalog', cache: 'etag' }                 // always revalidate, 304 is a hit
{ name: 'getSettings', get: 'settings', cache: true }                 // follow Cache-Control and ETag
{ name: 'getCountries', get: 'countries', cache: 24 * 3600 * 1000 }   // fresh for a day, whatever the server says
{ name: 'getFeed', get: 'feed', cache: { ttl: 30000, staleWhileRevalidate: true, staleIfError: true, persist: true } }
```

| Policy key | Meaning |
| --- | --- |
| `ttl` | milliseconds a response stays fresh; default: `Cache-Control: max-age` |
| `respectHeaders` | honour `max-age`, `no-store`, `no-cache`, `stale-while-revalidate` (default true) |
| `etag` | revalidate a stale entry with `If-None-Match` / `If-Modified-Since` (default true) |
| `staleWhileRevalidate` | `true` or ms: answer from the stale copy and refresh behind it; pass `onUpdate` to hear about new data |
| `staleIfError` | answer from the stale copy when the network or the server (5xx) fails |
| `persist` | also keep the entry in the persistent store |
| `vary` | request header names that are part of the key (`['Accept-Language']`) |

A 304 resolves like any response, from the stored copy: `response.notModified`
and `response.fromCache` are true and the body is not parsed again.

```javascript
api.cache.invalidate('getArticle', { id: 42 });   // one request
api.cache.invalidate('getArticles');              // every cached response of a method
api.cache.invalidate(/\/articles/);               // by URL
api.cache.clear();
{ name: 'updateArticle', put: 'articles/<id>', invalidates: ['getArticles', 'getArticle'] }
```

An invalidation also covers requests that are on their way: the answer to a
GET that was sent before the invalidation is handed to its caller but not
kept, and a 304 that lands afterwards does not bring the entry back.

Memory holds the 100 most recently used entries (`cache.maxEntries`). For
entries that should survive a restart, give the cache a store:

```javascript
cache: { store: Reste.fileStore('api-cache') }     // one file per entry in the app's cache directory
cache: { store: Reste.propertiesStore() }          // Ti.App.Properties: small, public responses only
```

A store has `getItem`, `setItem`, `removeItem` and `keys()`; without `keys()`
entries of an earlier launch cannot be invalidated or cleared.

### Whose answer is it

A cached response is only right for the request that would get the same
answer again. RESTe does three things about that, and you should do a fourth:

- `Vary` is honoured: a response that varies on a request header is a hit only
  while that header has the same value, and `Vary: *` is never cached.
- A response that varies on a credential header (`Authorization`, `Cookie`,
  anything named like a token or key) is kept in memory only, never written to
  the store. What is written keeps the body and four headers (`ETag`,
  `Last-Modified`, `Cache-Control`, `Content-Type`); cookies and all other
  response headers stay out.
- `cache: { scope: () => session.userId }` puts the user into every cache key.
- `api.session.reset()` clears the cache. Call it at sign-in as well as at
  sign-out.

Most APIs do not send `Vary: Authorization`. So for per-user data either set
`scope`, or do not `persist` it. `Reste.propertiesStore()` writes to
NSUserDefaults / SharedPreferences, which are included in device backups; use
`Reste.fileStore()` (the cache directory, not backed up) for anything that is
not public reference data.

Cached bodies are shared objects: do not modify what a call resolved with.

## Interceptors

```javascript
api.config({
    interceptors: {
        request(request) {                      // may return a promise
            request.headers['X-Trace'] = newTraceId();
        },
        response(response, request) {
            metrics.timing(request.name, response.duration);
        },
        error(error, request) {
            if (error.status === 404 && request.name === 'getAvatar') {
                return { resolve: null };       // recover: the call resolves with null
            }
        }
    }
});

const remove = api.use({ request: addDebugHeader });   // add later; remove() takes it out again
```

Order: global, then the method's, then the call's. A request interceptor sees
and may change `{ name, method, url, headers, body, timeout, params, attempt,
idempotencyKey, meta }`; it runs for every attempt. An error interceptor
returns nothing (pass the error on), an `Error` (replace it), or
`{ resolve: value }` (recover). Throwing from a request or response
interceptor fails the call with what was thrown.

## Status hooks

```javascript
api.config({
    onStatus: {
        401: (error, request) => signOut('Your session ended.'),
        426: () => showUpdateScreen(),
        429: error => toast('Slow down, try again in ' + Math.ceil(error.retryAfter / 1000) + ' s')
    }
});
```

A hook fires once per event, not once per request: when five requests are in
flight and all come back 401, the hook runs once; the other four join that
firing. A request sent after the hook fired starts a new event.

A hook can ask for the failed requests to be sent again, which is how a token
refresh is done:

```javascript
onStatus: {
    401: () => refreshToken().then(() => 'retry', () => { signOut(); })
}
```

Every request that failed with that status (including those that fail while
the refresh is still running) waits for the one refresh and is then sent once
more. What may be sent again follows the rule under [Retries](#retries): after
a 401 (or another status in `authStatuses`) every request, after any other
status only requests that are safe to repeat. So a hook on 503 that answers
`'retry'` re-sends GETs and keyed requests, never a plain POST.
`request.retried` tells the hook that a request already had its second chance,
and a hook's answer that arrives after the session was reset re-sends nothing.

## Sessions

```javascript
api.session.reset();          // sign-out, "session expired", sign-in, a different user
```

Requests that were in flight are aborted and reject with `kind: 'stale'`; a
response that still arrives is dropped, and a request that was waiting to be
retried is not sent. A request the server has already answered keeps its
answer: the 401 whose status hook calls `reset()` still rejects with that 401. Nothing of the previous session reaches a callback, a
global error handler or a collection, and nothing of it is sent with the next
session's credentials. The cache (memory and persistent store), idempotency
actions, identity maps and the collections' paging state are cleared.

Call it when a session ends **and** when one begins: a sign-in that follows a
sign-out the app never saw (a crash, a token that was simply replaced) should
not inherit anything.

Options: `abort: false` (let the requests finish, still drop their answers),
`clearCache: false`, `resetCollections: true` (also empty every collection and
singleton model). Methods defined with `session: false` are not tied to a
session.

## Cancelling

```javascript
const handle = api.getArticles();
handle.abort();                                   // rejects with kind 'cancelled'

const screen = api.createAbortController();       // one signal for everything a screen loads
api.getArticle({ id }, { signal: screen.signal });
api.getComments({ article: id }, { signal: screen.signal });
$.window.addEventListener('close', () => screen.abort());

api.abortAll();                                   // everything in flight
api.abortAll(request => request.name === 'search');
```

`abort()` works at any point: while an interceptor is still working, during a
retry's back-off, mid-upload. A cancelled request calls no callback and no
global error handler; only its promise rejects (with what `mapError` makes of
it, when there is one).

## Uploads and downloads

```javascript
{ name: 'uploadFile', post: 'articles/<article>/files', multipart: true }

const handle = api.uploadFile({
    article: 42,
    body: {
        file: blob,                               // Ti.Blob or Ti.Filesystem.File
        'documents[]': [fileA, fileB],            // -> documents[0], documents[1]
        caption: 'Cover',
        tags: ['a', 'b'],                         // -> tags[0], tags[1]
        meta: { private: true }                   // -> meta[private]
    }
}, {
    onProgress: fraction => ($.progress.value = fraction)
});
$.cancel.addEventListener('click', () => handle.abort());
const uploaded = await handle;
```

A body that holds a blob or a file is sent as multipart without
`multipart: true`. Titanium writes the multipart boundary, so RESTe removes any
`Content-Type` of its own (the JSON default included). Uploads go through the
same headers, interceptors, error mapping, status hooks and idempotency keys
as every other request; like any POST, an upload is retried only when it
carries an idempotency key.

```javascript
{ name: 'getInvoice', get: 'invoices/<id>/pdf', download: true }

const file = Ti.Filesystem.getFile(Ti.Filesystem.applicationCacheDirectory, 'invoice.pdf');
await api.getInvoice({ id: 7 }, { file, onProgress: fraction => ... });   // resolves with the file
```

Platform notes, measured on SDK 13.4.1: Android reports upload progress every
few hundred bytes (6145 events for 3 MB), iOS a handful of times; RESTe passes
progress on in steps of `progressStep` (1 %). Android does not keep the order
of multipart fields. Android's HTTP client sends `DELETE` without its body
(iOS sends it): put such data in the URL, or see
[Method override](#method-override). A boolean in a flat form body is
written by the platform, as in 1.x: `true` on Android, `1` on iOS; pass a
string to decide yourself.

## Method override

Titanium's Android HTTP client sends a `DELETE` without its body. When an
endpoint needs that body (a password to confirm the deletion, say) and the
server understands a method override, RESTe can send the request as `POST`
with the real method in a header:

```javascript
api.config({ methodOverride: true });                       // X-HTTP-Method-Override: DELETE
api.config({ methodOverride: { header: 'X-HTTP-Method', methods: ['DELETE', 'PATCH'], always: true } });
{ name: 'closeAccount', delete: 'account', methodOverride: true }    // or per method; false opts one out
```

| Key | Default | |
| --- | --- | --- |
| `header` | `X-HTTP-Method-Override` | the header that carries the method |
| `methods` | `['DELETE']` | the methods it applies to |
| `always` | `false` | `false`: only where the platform would drop the body, and only for a request that has one (today: `DELETE` on Android). `true`: every request of those methods on every platform, for a network that lets only `GET` and `POST` through |

It is off by default because the server has to take part: check that yours
honours the header (many frameworks do, some only once it is switched on)
before turning this on. Only the wire changes. For retries, status hooks,
interceptors, the log and errors the request is still the `DELETE` it was
asked to be: an override never makes it repeatable. Without the option, RESTe
warns once on Android when a `DELETE` is given a body.

## Pagination

Tell a method how its API pages; set defaults for all of them in
`config.pagination`.

```javascript
// ?page=2&per_page=20  ->  { data: [...], meta: { current_page, last_page, total } }
{ name: 'getArticles', get: 'articles', paginate: { style: 'page', perPage: 20 } }

// ?limit=30&before=<id> / ?after=<id>  ->  { data: [...], meta: { has_more } }
{ name: 'getMessages', get: 'rooms/<room>/messages', paginate: { style: 'cursor', limit: 30 } }

// ?cursor=<token>  ->  { items: [...], next_cursor }
{ name: 'getFeed', get: 'feed', paginate: { style: 'cursor', cursorParam: 'cursor', nextCursor: 'next_cursor', items: 'items', order: 'desc' } }
```

| Key (page style) | Default | |
| --- | --- | --- |
| `pageParam`, `perPageParam`, `perPage`, `firstPage` | `page`, `per_page`, none, `1` | what is sent |
| `items`, `meta` | the unwrapped data, the response's meta | where the list and the metadata are: a path or a function of the body |
| `page`, `lastPage`, `total` | `current_page`, `last_page`, `total` | paths in the metadata |
| `hasMore` | derived | a path in the metadata or `(meta, page) => boolean` |

| Key (cursor style) | Default | |
| --- | --- | --- |
| `limitParam`, `limit` | `limit`, none | |
| `order` | `'asc'` | how the list is held: `'asc'` oldest first (a chat), `'desc'` newest first (a feed) |
| `nextParam`, `previousParam`, `cursorOf` | `before`, `after`, `'id'` | id cursors: `next()` sends the oldest item's cursor, `previous()` the newest's |
| `cursorParam`, `nextCursor`, `previousCursor` | | token cursors: the parameter, and where the body holds the next token |
| `hasMore` | `'has_more'` | a path in the metadata or a function |

Without metadata, a full page means "there may be more" and a short page is
the end.

A pager walks a method:

```javascript
const pager = api.paginate('getArticles', { query: { status: 'published' }, perPage: 20 });
const page = await pager.next();      // { items, meta, page, lastPage, total, hasMore, done }
pager.items, pager.hasMore, pager.page, pager.total, pager.meta, pager.loading
await pager.refresh();                // the first page again; the list is replaced by it
await pager.previous();               // cursor style: what is newer than the newest item held
pager.abort();
```

It drops rows it already holds (pages shift when the server gets a new row),
shares concurrent `next()` calls, and discards a page that a `refresh()` made
obsolete. A plain call of a paginated method still returns the items;
`fullResponse` gives the metadata as `response.meta`.

## Models and collections

Define models next to the methods; RESTe creates the Backbone model classes
and puts the collections in `Alloy.Collections` (and in `api.collections`).
Do not also define them in `app/models` or with `<Collection src>`.

```javascript
api.config({
    unwrap: 'data', meta: 'meta',
    methods: [
        { name: 'getArticles', get: 'articles', paginate: 'page' },
        { name: 'getArticle', get: 'articles/<id>' },
        { name: 'createArticle', post: 'articles', idempotent: true },
        { name: 'updateArticle', put: 'articles/<id>' },
        { name: 'patchArticle', patch: 'articles/<id>' },
        { name: 'deleteArticle', delete: 'articles/<id>' }
    ],
    models: [{
        name: 'article',
        id: 'id',                                   // the id attribute
        read: 'getArticle', create: 'createArticle', update: 'updateArticle', patch: 'patchArticle', delete: 'deleteArticle',
        content: 'data',                            // where the model is in a response
        transform: model => Object.assign(model.toJSON(), { date: format(model.get('published_at')) }),
        identity: true,                             // one model per id, shared by all collections
        collections: [{ name: 'articles', read: 'getArticles', content: 'data', merge: true }]
    }]
});
```

```xml
<TableView dataCollection="articles" dataTransform="transformArticle">
    <TableViewRow title="{title}" articleId="{id}"/>
</TableView>
```

`Backbone.sync` is not touched: each model class and collection made here has
its own `sync`. Other models in the app, and other RESTe instances, are
unaffected.

A model's id is its `id` attribute, as in 1.x. When the server calls it
something else (`id: 'objectId'`), that attribute is copied into `id` for
everything that arrives, so `model.id`, `collection.get(id)`,
`createModel(name, { id })` and URLs with `<id>` or `<objectId>` all work.
`mirrorId: false` makes the configured attribute the model's id instead and
copies nothing.

### Loading

```javascript
const articles = Alloy.Collections.articles;

articles.fetch();                          // as Backbone does it (reset on 0.9.2, set on 1.x) unless merge is on
articles.fetch({ merge: true });           // merged in place; `merge: true` on the collection makes it the default
articles.fetch({ status: 'published' });   // fills <status> in the URL, as in 1.x
articles.fetch({ query: { status: 'published' }, headers, timeout, signal });
articles.refresh();                        // the first page again, merged in place
articles.fetchNext();                      // the next page, appended; fetchPrevious() for cursor lists
articles.hasMore(); articles.paging; articles.meta // { page, lastPage, total, hasMore, ... } and the last response's metadata
articles.upsert(items, { position: 'start' });   // merge items from anywhere: a socket message, a push payload
```

All of them return the request's promise with `abort()`. Merges resolve with
`{ models, added, changed, removed, touched }`.

A merge keeps what is there: an item whose id is known updates that model
(only attributes that differ are set, so only those fire `change`), a new one
is added, and on a refresh models the server no longer sends are removed and
the order follows the server's (or the collection's comparator). Nothing is
rebuilt, so references to models stay valid and a bound list is not rendered
when nothing changed.

During a merge the collection holds back per-model events and announces the
result once: `update` (with `changes: { added, removed, merged }`) and
`fetch`, the event Alloy's data binding renders on. That is one render per
merge instead of one per row. `events: 'each'` (per call, per collection or in
the config) restores Backbone's per-model events; `changeEvent` names another
event.

When a refresh returns exactly the bytes the collection was last refreshed
from, and nothing touched the collection since, the body is not parsed and
nothing is merged: the result has `unchanged: true`
(`skipUnchanged: false` switches this off). With `cache: 'etag'` on the method
the server does not even send the body.

Large lists can be merged in pieces so the UI thread gets to breathe:
`chunk: 100` (per call, per collection or in the config) merges 100 items per
turn of the event loop and announces the change at the end.

### Saving

```javascript
const article = api.createModel('article', { title: 'New' });
await article.save();                                    // POST: create
await article.save({ title: 'Renamed' });                // PUT: update
await article.save({ title: 'Renamed' }, { patch: true });   // PATCH with only these attributes
await article.fetch();                                   // GET
await article.destroy();                                 // DELETE (no body unless beforeDelete returns one)
```

`save`, `fetch` and `destroy` take Backbone's `success` and `error` callbacks
and also return the request's promise. Path placeholders the call does not
fill come from `options.params`, then from the model's attributes, so nested
resources work: `articles/<article_id>/comments/<id>`. `beforeCreate(body, model)`,
`beforeUpdate` and `beforeDelete` can reshape what is sent.

`singleton: true` on a model also keeps one instance in `Alloy.Models`;
`model.replace(attributes)` makes it hold exactly those attributes.

### One model per id

With `identity: true`, a row in a list and the detail of the same resource are
the same object: a list response and `GET articles/42` both land in it, every
collection that contains it follows, and fields that one response lacks stay
from the other.

```javascript
const article = api.model('article', 42);     // the instance for that id, created empty if nobody loaded it yet
article.fetch();
api.identity.get('article', 42); api.identity.clear('article');
```

Where the JavaScript engine has `WeakRef` (current Titanium does) the map holds
its models weakly: a model stays as long as a collection or a screen holds it
and is forgotten when nothing does. Without `WeakRef`, or with
`identity: { weak: false, limit: 1000 }`, it keeps the newest `limit` models
plus every model a collection holds. Identity maps are cleared by
`session.reset()`.

### Optimistic updates

```javascript
article.save({ status: 'done' }, { optimistic: true, patch: true });   // shown at once, put back if the server refuses
article.destroy({ optimistic: true });                                  // removed at once, put back where it was
articles.create({ title: 'Draft' }, { optimistic: true });              // in the list at once, taken out again on failure
```

On a rollback only attributes that still hold the optimistic value are
restored, so something typed in the meantime is not lost; the model fires
`rollback`. `optimistic: true` on a model definition makes it the default.

While an optimistic write is waiting for its answer, a list response that was
requested before it does not undo it: the changed attributes keep the device's
value, a model being destroyed is not re-added, and a model being created
keeps its row.

When the request is not the model's own save (a custom endpoint, a socket
send):

```javascript
notification.optimistic({ read_at: now }, () => api.markRead({ id: notification.id }));

messages.optimistic({ id: clientId, body, sending: true }, () => api.sendMessage({ room, body: { client_id: clientId, body } }));
```

The first puts the attributes back if the call fails. The second adds the
model now; when the call resolves the server's resource the model takes those
attributes and the real id in place, and if the server's copy reached the
collection first (a socket event beat the response) that one is kept and the
temporary model is dropped.

### Models and collections of your own

`upsert()`, `replace()` and `optimistic()` also exist as functions that take
the model or the collection, for the ones an app creates itself: a collection
made in `alloy.js`, a model built on the fly, anything in a test.

```javascript
api.upsert(collection, items, { position: 'start' });   // collection.upsert()
api.replace(model, attributes);                         // model.replace()
api.optimistic(model, changes, send);                   // model.optimistic()
api.optimistic(collection, attributes, send);           // collection.optimistic()
```

Given one of RESTe's own they do what the method does. A collection RESTe did
not create keeps Backbone's own events: an `add` or a `change` per model, not
one `update` and `fetch` per merge.

### Lists that follow a collection

When one collection is the place where every model of a resource lives, the
screens show selections of it: "published articles", "my drafts", one room's messages.
`api.list()` is such a selection: ordered, filtered, paginated, and following
the collection.

```javascript
const published = api.list({
    collection: 'articles',
    query: { status: 'published' },                               // sent with every page
    filter: model => model.get('status') === 'published',         // which models may join, and which members drop out
    signal: screen.signal                                    // destroyed with the screen
});
published.on('change', render);                // membership, order or a member changed: once per turn
published.on('state', updateSpinner);          // 'idle' | 'loading' | 'refreshing' | 'loadingMore' | 'error'
published.on('error', showError);

published.load();                              // what the collection already holds at once, then the first page
published.models();                            // the models, in order
published.loadMore(); published.refresh(); published.retry(); published.reload({ query, filter });
published.hasMore(); published.isEmpty(); published.total; published.state; published.error; published.failedMore
```

Pages are merged into the collection and decide the order. A model that
reaches the collection another way (a socket event, an optimistic create,
another list's page) joins when it passes `filter`, at `place` (`'start'`, or
`'end'` for an oldest-first cursor list); a member that stops passing it, or
leaves the collection, drops out. When a later page brings a model that had
joined on its own, it moves to where the server has it. What a page returns is
taken as the server gave it; `filter` only decides about joining and dropping
out. Cursor lists add `loadOlder()` and `loadNewer()`. `schedule` lets the app
decide when a change is delivered (after a transition, say).

Pages can also come from a function of your own, for an app whose screens go
through a service layer instead of calling methods:

```javascript
const mine = api.list({
    collection: Alloy.Collections.articles,                   // with `load`: any Backbone collection
    paginate: { style: 'page', perPage: 20 },
    filter: model => model.get('author') === me,
    load: (query, { signal }) => articleService.mine(query, { signal })   // -> { items, meta }
});
```

`load` gets the query of the page that is wanted (`{ page, per_page }`, or
`{ limit, before }` / `{ limit, after }` for a cursor list) and resolves
`{ items, meta }`, or just the array. The items may be plain objects, which
the list merges into the collection, or models the function has merged itself;
what it rejects with is the list's `error`. Everything else (order, joining,
dropping out, `state`, `retry()`) is as above.

## Hooks from 1.x

These work as before, for callbacks and for promises:

```javascript
api.config({
    beforeSend(body, send) { send(Object.assign({ locale }, body)); },   // every request
    beforePost(body, send) { send(body); },                              // POST only, before beforeSend
    onLoad(data, done) { done(data); },                                  // every response, before the caller
    onError(error, retry) { ... }                                        // errors nobody else handles
});
```

`send({ skip: true, ... })` stops the request and hands that value to the
caller as its result. A method definition may have its own four hooks; a
method's `beforeSend` / `beforePost` replace the global ones, a method's
`onLoad` runs after the global one, and a method's `onError(error, done,
retry)` takes precedence over the caller's and the global handler. For new
code, interceptors and `mapError` do the same with fewer surprises.

## Logging

`debug: true` logs one line per request and response (`::RESTE::GET ... 200 in
84ms`); `debug: 'verbose'` adds request headers and request bodies. Response
headers and bodies are never logged.

A custom `logger(level, message, details)` gets every line instead of the
console. For the lines about a request, `details` holds the facts, so an app
can print a line in its own format or keep request timings:

```javascript
logger(level, message, details) {
    if (details && details.event === 'response') {
        console.log(`[api] ${details.method} ${details.url} ${details.status} ${details.elapsed}ms`);
    }
}
```

| `details.event` | when | fields besides `endpoint`, `method`, `url`, `attempt` |
| --- | --- | --- |
| `request` | an attempt is sent | |
| `retry` | an attempt failed and will be repeated | `status`, `kind`, `elapsed`, `delay` |
| `response` | the call succeeded | `status`, `elapsed`, `duration`, `fromCache`, `notModified` |
| `error` | the call failed, or was cancelled | `status`, `kind`, `elapsed`, `duration` |

`elapsed` is the time of the last exchange, `duration` that of the whole call
including back-off; `url` is the URL as it is printed, after redaction.

Before a line is printed, every value whose **name** looks like a credential
is replaced by `[redacted]`:

- request headers, fields of JSON and form bodies at any depth (also when the
  body is a JSON or form *string*), and query parameters;
- path values whose placeholder is named like a credential (`auth/verify/<token>`)
  or that the method lists: `{ name: 'reset', get: 'reset/<code>/<user>', redact: ['code'] }`.

A name looks like a credential when, ignoring case and punctuation, it
contains `token`, `secret`, `password`, `passwd`, `passphrase`, `signature`,
`credential`, `authorization`, `cookie`, `apikey`, `privatekey`, `sessionid`,
`otp`, `cvv`, `cvc` or `cardnumber`, ends in `key`, or is one of `key`, `sig`,
`pin`, `pwd`, `auth`, `jwt`, `sid`, `ssn`, `code`. So `accessToken`,
`refresh_token`, `X-Amz-Signature`, `X-Api-Key` and `?key=` are all covered. A
string body that is neither JSON nor a form is printed as its length only.

What this cannot do: recognise a secret under an innocent name (`value`,
`data`), inside free text, or in a path segment it was not told about. Add
names with `redact: { headers: ['X-Tenant'], keys: ['iban'] }`, rewrite URLs
with `redact: { url: (url, request) => ... }`, send the lines elsewhere with
`logger: (level, message, details) => ...`, and do not ship with `debug` on.

## TLS

RESTe never changes how certificates are checked. To pin certificates pass a
security manager, per instance or per method; it is handed to the HTTP client
when it is created (the only moment Android accepts it):

```javascript
api.config({
    securityManager: require('appcelerator.https').createX509CertificatePinningSecurityManager([...]),
    clientOptions: { tlsVersion: Ti.Network.TLS_VERSION_1_3 }
});
```

`clientOptions` passes these HTTP client properties through: `autoEncodeUrl`,
`autoRedirect`, `cache`, `domain`, `enableKeepAlive`, `username`, `password`,
`tlsVersion`, `withCredentials`. `validatesSecureCertificate` is passed only
when you set it; setting it to `false` switches certificate checks off, and
RESTe says so in the debug log.

## Recipes

### An auth token

```javascript
api.config({
    requestHeaders: { Authorization: () => (session.token ? 'Bearer ' + session.token : null) },
    methods: [
        { name: 'login', post: 'auth/login', session: false, statusHooks: false },
        ...
    ],
    onStatus: {
        401: () => {
            session.clear();
            api.session.reset();          // drop everything that was on its way for that user
            showLogin();
        }
    }
});
```

A header whose function returns `null` is not sent; one that throws rejects
the call. With refresh tokens, return the refresh from the hook as shown under
[Status hooks](#status-hooks). Default headers never go to another origin, so
a presigned upload URL or a maps API does not receive the token.

### An error envelope

See [Your own error class](#your-own-error-class). For form errors the mapped
error usually carries `error.body.errors`; network errors can be given the
same shape so a form has one way to show a problem.

### A paginated, pull-to-refresh list

```javascript
const articles = Alloy.Collections.articles;            // collections: [{ name: 'articles', read: 'getArticles', merge: true }]

$.list.addEventListener('refreshstart', () => articles.refresh().then(done, done));
$.list.addEventListener('marker', () => articles.hasMore() && articles.fetchNext());
articles.fetch();
```

### A chat thread

```javascript
// { name: 'getMessages', get: 'rooms/<room>/messages', paginate: { style: 'cursor', limit: 30 } }
const thread = api.list({ collection: 'messages', params: { room }, filter: m => m.get('room_id') === room });
thread.on('change', render);
thread.load();                                   // the newest 30
onScrolledToTop(() => thread.loadOlder());
socket.on('message', item => Alloy.Collections.messages.upsert(item));   // joins at the end
socket.on('reconnect', () => thread.loadNewer());
```

### An upload with a progress bar and a cancel button

See [Uploads and downloads](#uploads-and-downloads).

### Cached reference data

```javascript
{ name: 'getCategories', get: 'categories', cache: { persist: true, ttl: 0 } }   // revalidated with its ETag on every start
{ name: 'getAppConfig', get: 'config', cache: true, session: false }             // as long as Cache-Control allows
```

### An optimistic toggle

```javascript
function onFavourite(article) {
    article.save({ favourite: !article.get('favourite') }, { optimistic: true, patch: true })
        .catch(error => toast('Could not save: ' + error.message));
}
```

## Migrating from RESTe 1.x

Replace the file. A 1.x config keeps working. The repository runs 62 scenarios
taken from upstream's README against upstream and against this build, side by
side (`test/differential/`); they behave the same except for the rows below,
and that list is checked by the test suite, so it is complete for what those
scenarios cover.

**Check these: your code may rely on the old behaviour.**

| 1.x | 2.0 | What to do |
| --- | --- | --- |
| Without `errorsAsObjects: true`, error callbacks get the response body | They get an error object (1.x announced this). It has `code`, `content`, `error`, `url`, and always a `message` | Read the body from `error.content` (so `e.message` becomes `e.content.message`), or set `errorsAsObjects: false` to keep 1.x's values |
| `error.url` is the method's URL as configured (`classes/videos`) | It is the full URL that was requested | Only matters if you compare it |
| An error that no error callback and no `config.onError` handles is passed to the success callback | It is logged and the promise rejects; the success callback is not called. With `errorsAsObjects: false` the 1.x behaviour stays | Pass an error callback or set `config.onError`; or set `errorsToOnLoad: true` |
| Path values are put into the URL as they are | They are URI-encoded | Remove your own `encodeURIComponent`; for a value that is meant to contain `/`, set `encodeParams: false` on that method (or globally) |
| A missing `<placeholder>` is sent literally; an empty string gives `videos/` | The call rejects with `kind: 'params'`. An empty string is still accepted after the `?` | Make sure ids are set before calling |
| `autoValidateParams` and `expects` throw a string from the call; `expects` treats `0`, `false`, `''` as missing | The call rejects (the error callback is called); only `null` and `undefined` are missing | Replace `try / catch` around calls by the error callback |
| Default headers are sent with every method, also those with a full URL | They are sent to relative URLs and to full URLs on the base URL's origin only | A method on another host that needs them: `globalHeaders: true` |
| A string body is JSON-encoded (`"text"`) | It is sent as it is | Remove workarounds; pass objects for JSON |
| Without a `Content-Type` header, a JSON body goes out with the platform's default type | It goes out as `application/json` | Set your own `Content-Type` if the server expects another |
| Nested objects in a form-encoded body are handed to the HTTP client as objects | They are flattened to `name[child]=value` | Only matters if you relied on the platform's rendering of an object |
| `beforePost` *or* `beforeSend` runs for a POST | Both run, `beforePost` first, as the README always said | Check a `beforeSend` that must not see POSTs |
| `beforeCreate` runs on delete and `beforeDelete` on create | Each runs on its own operation | Swap them back if you had swapped them to compensate |
| `destroy()` sends the model as the DELETE body, and a DELETE without a body sends `{}` (both on upstream master only; 1.6.0 sends neither) | No body, unless you pass one or `beforeDelete` returns one | A server that needs the body: return it from `beforeDelete` (note: Titanium's Android client drops DELETE bodies) |
| An empty response body is `''` | It is `null` | Compare with `== null`, or test truthiness |
| Text that is not JSON but is served as `application/json` reaches the success callback as text | It is an error (`kind: 'parse'`, the text in `error.body`) | Fix the server's content type, or set `responseType: 'text'` on that method |
| A success response whose body has `code > 200` is treated as an error by models | Only the HTTP status decides | Check the field yourself if your API reports errors with status 200 |
| A call returns the HTTP client | It returns a promise with `abort()` | Code that used other members of the client: ask for `fullResponse` and use `response.http` |
| `Backbone.sync` is replaced | It is left alone | Plain Backbone models that relied on RESTe's global sync: define them in `models` |

**These changed too, and need nothing from you.**

| 1.x | 2.0 |
| --- | --- |
| `config.Q` is needed for promises (and they never resolved after 1.5) | Every call returns a native promise; `Q` is ignored |
| `method(onLoad, onError)` without params uses the *error* callback for success | The first is success, the second is error |
| `config()` twice throws | It replaces the configuration |
| `changeRequestHeader({ a, b })` changes `a` only | It changes both |
| Items of a model without an `id` setting lose their `id` | They keep it |
| `fetch()` fires `sync` twice on Backbone 1.x | Once |
| `createModel` returns a plain `Backbone.Model`; `createCollection` returns nothing | The configured model class; the collection |
| A header function is called twice per request | Once |
| A second instance with models breaks the first | Instances are independent |

Retries, the cache, de-duplication, pagination and merging are all off until
configured. Collections keep Backbone's fetch semantics until you set
`merge: true`.

## Performance

`npm run bench` compares this build with upstream master in Node, with an HTTP
client that answers synchronously so only the library's own work is measured.
Medians of two runs on a shared machine (Node 22, Xeon E5-2690 v4), given as
the range between them:

| Measurement | upstream | 2.0 | |
| --- | --- | --- | --- |
| `config()` with 500 methods | 0.6 to 0.7 ms | 0.7 to 1.3 ms | 2.0 analyses a method on its first call |
| `config()` with 500 methods, then the first call of 20 of them | 0.8 to 0.9 ms | 1.7 to 2.0 ms | what an app start pays: about twice upstream, a millisecond more |
| one GET, small JSON, callbacks | 3.7 to 4.3 µs | 6.7 to 8.7 µs | the promise, its handle and the response object: 3.4 kB allocated per request against 2.3 kB |
| one GET with retry, de-duplication, interceptors and unwrap on | | 12.7 to 13.7 µs | |
| GET a 500-item list (148 kB) | 2.3 to 2.4 ms | 1.5 ms | parsed once instead of twice |
| the same list again, ETag unchanged | (as above) | 0.30 to 0.36 ms | no body, no parse |
| Backbone 1.4.0: first fetch of 500 items into a collection | 8.3 to 9.8 ms, 501 renders | 9.0 ms, 1 render | "renders": events an Alloy `dataCollection` view rebuilds on. No difference in library time; the difference is the 500 renders |
| Backbone 1.4.0: fetch again, nothing changed | 5.0 to 6.2 ms | 0.8 to 1.1 ms, 0 renders | |
| Backbone 1.4.0: fetch again, 10 of 500 changed | 5.3 to 9.0 ms, 10 renders | 3.1 to 5.7 ms, 1 render | |
| Backbone 0.9.2: first fetch of 500 items | 9.1 to 12.5 ms, 1 render | 6.3 to 6.8 ms, 1 render | |
| Backbone 0.9.2: fetch again, nothing changed | 7.5 to 9.1 ms, 1 render | 1.0 to 1.8 ms, 0 renders | |
| Backbone 0.9.2: fetch again, 10 of 500 changed | 7.8 to 8.8 ms, 1 render | 2.8 to 4.6 ms, 1 render | |
| merging 2000 items: longest block on the thread | | 36 to 44 ms whole, 16 to 19 ms with `chunk: 100` | the remaining block is `JSON.parse` |

The fixed costs went up: a request costs about twice upstream's (3 to 4
microseconds and a kilobyte more), and so does defining methods and calling
them for the first time. Both are far below the cost of the HTTP exchange
they belong to; what an app notices is the work
per list, and the renders. JavaScript in Titanium runs on one thread, so a
response cannot be parsed off it; what 2.0 does instead is parse once, not at
all when the server says (or the bytes show) that nothing changed, and merge
in chunks when asked.

The example app prints the same measurements on a device (`RESTE-BENCH` lines).

## Tested with

Verified by running, not only by unit tests:

- **Node**: `npm test` runs the suite against the sources and against the
  built `reste.js`: 834 tests each time. Many of them are the same test
  repeated on each Backbone version Alloy ships (0.9.2, 1.1.2, 1.3.3, 1.4.0,
  1.6.0); there are 396 distinct tests. They cover the request pipeline on a
  scripted HTTP client, models and collections, an integration suite over real
  sockets against `test/server/server.js`, and 62 scenarios from upstream's
  README run against upstream and this build side by side.
- **Mutation check**: `npm run mutate` breaks 58 safety-relevant lines one at
  a time (what may be retried, what a session reset drops, what the log
  prints, what the cache keeps); every one makes a test fail.
- **Android**: Titanium SDK 13.4.1.GA, Alloy 3.0.1, Android 15 (API 35, x86_64
  container): the example app's 48 on-device checks pass.
- **iOS**: Titanium SDK 13.4.1.GA, Alloy 3.0.1, iOS 27.0 simulator (iPhone 18
  Pro, Xcode 27.1): the same 48 checks pass.

The on-device checks cover what only a device can show: how each platform's
HTTP client reports timeouts, dropped connections, conditional requests,
headers and progress; multipart bodies read back by the server; Alloy's own
Backbone and a bound `TableView`. Platform differences they found are
handled or documented: iOS reports a 304 as the stored 200, Android reports
upload progress thousands of times, drops the body of a DELETE and does not
keep the order of multipart fields.

Not tested: a physical phone, Titanium SDKs older than 13.4.1, and Backbone
versions other than 1.4.0 on a device (Node covers all five).

## Development

```bash
npm install
npm test            # build, then the suite against src/ and against reste.js
npm run lint
npm run types       # type-check reste.d.ts against a usage sample
npm run mutate      # break safety-relevant lines one by one; every break must fail a test
npm run bench
npm run server      # the test server on :8787, for the example app
```

Sources are in `src/`; `reste.js` is generated by `npm run build` and
committed, so the repository always holds the file people copy. The example
app and how to run its checks are described in
[example/README.md](https://github.com/centrevilletech/Ti.ModernRESTe/blob/HEAD/example/README.md).

## License and credit

RESTe was created by [Jason Kneen](https://github.com/jasonkneen), with
contributions from the Titanium community; this repository is a fork of his
work and keeps its history. The changes in this fork are by Centreville Tech
LLC and are offered back to the upstream project.

<pre>
Copyright Jason Kneen
Modifications Copyright 2026 Centreville Tech LLC

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
</pre>
