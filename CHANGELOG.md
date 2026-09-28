# Changelog

All notable changes to this project will be documented in this file.

## [0.0.0] - 2026-09-28

Ported from the [`lestack`](https://github.com/johnhenry/lestack) monorepo,
where it lived as a private (`"private": true`), unpublished showcase app
for lestack's other packages. Never published under any other name.

### Changed

- All imports switched from the lestack workspace packages to their
  `@johnhenry` scoped equivalents: `leserve` -> `@johnhenry/leserve`,
  `leroute` -> `@johnhenry/letterpress`, `signalle` -> `@johnhenry/signalle`,
  `http-fields` -> `@johnhenry/http-fields`, `http-converter` ->
  `@johnhenry/http-converter`, `lemem` -> `@johnhenry/packfile`.
- **`vimble` -> `@johnhenry/andbox`**, a real port rather than a rename.
  vimble's `run()`/`InjectedConsole` (used by the custom script-route
  feature to execute a user-provided handler with injected
  `console`/`request`/`context` globals) is replaced with andbox's
  `createSandbox({ mode: 'inline' }).execute()`. `inline` mode was chosen
  deliberately over andbox's default `worker` mode: vimble's own `run()`
  never provided real isolation either (just a `data:` URL dynamic import
  for scoping), and a live `Request` object (with a body stream) can't
  cross a Worker's structured-clone boundary the way this feature expects
  to use it directly. `console` is still supplied as an injected global
  (`InjectedConsole`, vendored locally as `injected-console.mjs`) rather
  than andbox's own `print()`/`onConsole` mechanism, so route scripts keep
  using plain `console.log(...)` unchanged.
- **`timed-fetch.mjs`'s connection-options building now uses the new
  `@johnhenry/webwire` package's `toNodeRequestOptions()`**, disentangled
  from its own genuine value: per-socket timing instrumentation
  (lookup/connect/secureConnect hooks, TTFB/transfer/total marks).

### Fixed

- **Proxy mode was forwarding the client's own `Host` header to the
  upstream unfiltered**, breaking any HTTPS target whose certificate
  doesn't cover the value the client sent (e.g. a client hitting prism as
  `localhost:4599`, proxied to `https://httpbin.org`, failed TLS hostname
  verification). Pre-existing -- present in the original `lestack` source
  unchanged -- found while verifying the `@johnhenry/webwire` port of
  `timed-fetch.mjs` end-to-end against a real upstream. Fixed in both proxy
  paths (`--target` mode and a custom `"type": "proxy"` route) by setting
  the forwarded `Host` header to the upstream's own host. Regression tests
  added in `test/inspector.test.mjs`. See AGENTS.md's gotchas.

### Added

- **`test/inspector.test.mjs`**: prism's first automated tests, exercising
  `createInspector()`'s router directly (in-process `Request`s, no real
  network bind or `~/.prism` disk writes). Covers the dashboard, echo
  capture, `/health`, `/history`, a custom script route via andbox
  (params, `console.log` capture, error-to-500), and a regression test
  documenting the known query-string route-matching bug (see AGENTS.md).
  A first pass, not full coverage — see AGENTS.md's Non-goals.

### Fixed (upstream, while porting)

Porting Prism surfaced four real migration gaps in already-scoped
`@johnhenry` packages -- capabilities that existed in the pre-scoping
`lestack` originals and were dropped during each package's own rename, not
intentionally removed. Each was fixed at the source (with its own tests)
rather than worked around here:

- `@johnhenry/letterpress`: `router.mount(prefix, subHandler)` (used to
  mount the dashboard sub-router under `/inspect`) and the `ctx`-forwarding
  its `mountPrefix` depends on; `createRewriter` (`@johnhenry/letterpress/rewrite`,
  used by proxy mode's rewrite-rules feature).
- `@johnhenry/leserve`: `toWebResponse` (`@johnhenry/leserve/node-to-web`,
  converts a Node client-response into a Web `Response`, needed when
  forwarding to an upstream in proxy mode).
- `@johnhenry/http-fields`: `parseAuto` (auto-detects and parses a
  structured field's type, used for the dashboard's per-header structured
  view).

See each package's own CHANGELOG for details.
