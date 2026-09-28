# Agent playbook

`@johnhenry/prism` — a live HTTP request inspector and debugging proxy with
a real-time web dashboard. Single package, Node >= 26, `node --test test/`
(`npm test`), ships source directly — no build step. `test/inspector.test.mjs`
exercises `createInspector()`'s router directly (in-process `Request`
objects, no real network bind, no `storagePath`/`routesPath` so it never
touches `~/.prism`) — it's a first pass (dashboard HTML, echo capture,
`/health`, `/history`, a custom script route via andbox including params
and console-log capture, error handling), not full coverage of
`inspector.mjs`'s ~1100 lines. Grow it as you touch new behavior rather than
treating manual curl-ing as the only verification going forward.

`CLAUDE.md` in this directory is a symlink to this file.

## The verification loop (before every push)

1. `npm test` — must stay green; no test here should SKIP.
2. `npm start -- --port <N>` and exercise it manually at least once per
   change to server.mjs/cli.mjs specifically (the test suite calls
   `createInspector()` directly and never boots the real HTTP server or
   parses real CLI args):
   - `curl http://localhost:<N>/inspect/hello` — echo capture.
   - `curl http://localhost:<N>/inspect/` — dashboard HTML loads.
3. `npm pack --dry-run` — read the file list, not just the exit code.
4. A genuinely fresh clone: `git clone . /tmp/prism-verifyN && cd $_ && npm ci && npm test && npm start`.
5. Commit, push, close the issue with a comment naming the commit SHA.

## Repo-specific gotchas

- **`~/.prism/routes.json` and `~/.prism/history.jsonl` persist across
  restarts by default** (unless `--no-persist`/no `--routes` is passed).
  Manual testing that registers routes or captures requests will see STALE
  data on the next run if you don't delete these first — this cost real
  debugging time while porting (a stale route with a bug in it kept
  matching first, over a corrected route registered later, because
  `matchRoute` is first-match-wins and `routes.push` only appends). Always
  `rm -f ~/.prism/routes.json ~/.prism/history.jsonl` before a clean test.
- **FIXED, but easy to reintroduce: custom route matching used to not
  strip the query string from the path being matched against.**
  `matchRoute(rawPath, method)` is called with `rawPath` =
  `url.pathname + url.search` (kept that way deliberately -- `entry.path`
  is also used for display in the capture feed, where showing the query
  string is useful), but `compilePath`'s regex has no provision for a
  trailing `?...`: for a static pattern the match failed outright
  (silently falling through to capture/proxy behavior); for a `:param`
  pattern, the query string got silently absorbed into the last param's
  value instead. `matchRoute` now strips the query string itself
  (`path.split("?")[0]`) before matching, rather than requiring
  `rawPath`'s one call site to pre-clean it -- if you add a new call site
  or change how routes are matched, keep that stripping (or move it to the
  call site, but don't drop it). Regression tests for both cases (static
  and `:param`) are in `test/inspector.test.mjs`.
- **FIXED, but easy to reintroduce: proxy mode used to forward the client's
  own `Host` header to the upstream unfiltered**, breaking any HTTPS target
  whose certificate doesn't cover whatever value the client happened to
  send (e.g. a client hitting prism as `localhost:4599` proxied to
  `https://httpbin.org` failed TLS hostname verification: "Host:
  localhost. is not in the cert's altnames"). Found while verifying the
  `@johnhenry/webwire` port of `timed-fetch.mjs` end-to-end; confirmed
  pre-existing (present in the original `lestack` source unchanged, not
  introduced by that port). Both proxy paths (`--target` mode and a custom
  `"type": "proxy"` route) now explicitly `proxyHeaders.set("host",
  targetUrl.host)` after building the forwarded headers, before calling
  `timedFetch()` -- `toNodeRequestOptions()` faithfully forwards whatever
  headers it's given, by design, so this has to be fixed at the call site,
  not in webwire. Regression tests in `test/inspector.test.mjs` spin up a
  real local HTTP server as a fake upstream and assert it receives its own
  host, not the client's -- if you touch either proxy path, keep this
  `proxyHeaders.set("host", ...)` call or the tests will catch it.
- **Custom script routes see a single `context` global (`{ params, query
  }`), not bare `params`/`query`.** `executeScriptRoute` builds
  `context = { params, query }` and passes it as one global alongside
  `request` and the sandboxed `console` — a script must destructure it
  itself (`const { params, query } = context;`, as `public/route-editor.html`'s
  own placeholder example correctly does) before using `params.id`/
  `query.x` directly. Writing bare `query.x` without that destructuring
  step throws `ReferenceError: query is not defined` — cost real debugging
  time while manually verifying the andbox port for exactly this reason.
- **`router.mount()`'s `mountPrefix` only reaches a mounted sub-router's
  handlers if that sub-router's own dispatch accepts the `ctx` argument
  `mount()` passes.** This works because `@johnhenry/letterpress`'s
  `createRouter` was extended (during this same port) to accept
  `router(request, ctx?)` and forward it to matched handlers and
  `defaultHandler` alike — if you ever swap the router library, confirm
  the replacement has an equivalent mechanism, or `entry.path` in the
  capture feed silently loses its `/inspect` prefix (cosmetic, not fatal,
  but a real regression if missed).
- **`ws-proxy.mjs` exists but is not currently wired into `inspector.mjs`**
  — carried over verbatim from the `lestack` original in the same state.
  `ws` is a real dependency because of this file, even though nothing
  imports it yet.

## Definition of done

- `npm test` passes clean and `npm start` boots without import errors.
- A new endpoint or behavior change in `inspector.mjs` gets a test in
  `test/inspector.test.mjs` (or a new file alongside it), not just a manual
  curl note — the suite is small enough right now that "I checked it by
  hand" is not a substitute for a regression test going forward.
- README/CHANGELOG updated for anything user-visible.

## Non-goals

- `test/inspector.test.mjs` is a first pass, not full coverage of
  `inspector.mjs`'s ~1100 lines (proxy mode, rewrite rules, replay/import,
  WebSocket proxying, and static/archive-backed routes have no tests yet).
  Growing it is real, ongoing work, not a one-time backfill to schedule.

## Releases

Bump `version` in `package.json` in a PR, add a `CHANGELOG.md` entry,
merge, then `gh release create v<version>` (fires `.github/workflows/publish.yml`,
gated on `npm test`/`npm pack --dry-run`).
