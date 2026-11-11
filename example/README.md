# RESTe example app

An Alloy app that uses RESTe the way an app would, and checks it on a real
device against the repository's test server.

| Tab | Shows |
| --- | --- |
| Things | a `TableView` bound to a collection (`dataCollection`), refreshed in place; optimistic create, update and a refused create that rolls back |
| Items | a paginated list: `fetch()`, `fetchNext()`, `refresh()` |
| Upload | a multipart upload with a progress bar and a cancel button; a download to a file |
| Checks | the on-device checks, and the measurements |

## Running it

```bash
# in the repository root
npm run build && cp reste.js example/app/lib/reste.js
npm run server                               # test/server/server.js on 127.0.0.1:8787

cd example
ti build -p android                          # or: -p ios -T simulator
adb reverse tcp:8787 tcp:8787                # Android: the device reaches the server on its own localhost
```

The server address is the `reste.server` property in `tiapp.xml`. An iOS
simulator shares the Mac's localhost, so run the server on the Mac. The app
allows plain HTTP to the local machine only for this purpose
(`usesCleartextTraffic`, `NSAllowsLocalNetworking`); an app that talks to a
real API needs neither.

## The checks

With `reste.autorun` set in `tiapp.xml` (the default) the checks run at launch
and write one line each to the log:

```
RESTE-CHECK PASS a timeout is reported as a timeout [after 713ms; platform message: "The request timed out." code -1001]
RESTE-CHECK FAIL <name>: <reason>
RESTE-BENCH collection-refetch-unchanged-ms 5
RESTE-CHECK DONE pass=48 fail=0 platform=iphone sdk=13.4.1
```

```bash
adb logcat -s TiAPI:V | grep RESTE-                                   # Android
xcrun simctl spawn booted log stream --predicate 'process == "ResteExample"' | grep RESTE-   # iOS simulator
```

They cover what the Node suite cannot: how each platform's HTTP client reports
timeouts, dropped connections, conditional requests, headers and progress;
multipart bodies as the server reads them; cancellation mid-transfer; Alloy's
own Backbone and a bound `TableView`. The code is in `app/lib/checks.js`.

## Results

Titanium SDK 13.4.1.GA, Alloy 3.0.1, Backbone 1.4.0: all 48 checks pass on both (47 in `checks.js` plus the data-binding check that uses the app's own `TableView`).

| | Android 15 (x86_64 container, software rendering) | iOS 27.0 simulator (iPhone 18 Pro) |
| --- | --- | --- |
| `config()` with 500 methods | 1 to 3 ms | under 1 ms |
| GET 500 items (148 kB) from localhost | 21 to 24 ms | 4 to 7 ms |
| first fetch of 500 items into a collection | 78 to 143 ms, 1 render | 7 to 25 ms, 1 render |
| fetch again, nothing changed | 28 to 85 ms, 0 renders, not parsed | 5 to 15 ms, 0 renders, not parsed |
| fetch again, 10 of 500 changed | 66 to 105 ms, 1 render | 4 to 15 ms, 1 render |
| merging 2000 items, longest block | 66 to 177 ms whole, 19 to 94 ms with `chunk: 100` | 12 to 42 ms whole, 6 to 26 ms with `chunk: 100` |
| timeout as the platform reports it | `"timeout"`, code -1001 | `"The request timed out."`, code -1001 |
| dropped connection | `"unexpected end of stream on ..."`, code -1 | `"The network connection was lost."`, code -1005 |
| conditional GET, server answers 304 | status 304 | status 200 (the stored response) |
| upload progress events for 3 MB | 6145 from the platform, 101 passed on | 1 |
| `DELETE` with a body | the body is dropped by the platform | sent |
| a boolean in a flat form body | `remember=true` | `remember=1` |

Times are the range over six runs on Android and three on iOS. They include
the HTTP exchange with a server on the same machine, on virtual devices that
share their host with other work, so they vary by a factor of three and are
not phone numbers. The counts, and what each platform reports, do not vary.
