# Prism

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fprism.svg)](https://www.npmjs.com/package/@johnhenry/prism)
[![CI](https://github.com/johnhenry/prism/actions/workflows/ci.yml/badge.svg)](https://github.com/johnhenry/prism/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fprism.svg)](LICENSE)

Full documentation: [opensource.johnhenry.me/prism](https://opensource.johnhenry.me/prism/)

> Ported from the [`lestack`](https://github.com/johnhenry/lestack) monorepo,
> where it lived as a private, unpublished showcase app for lestack's other
> packages. Never published under any other name -- starts at `0.0.0` here.

Live HTTP request inspector and debugging proxy.

Prism captures, inspects, replays, exports, and proxies HTTP requests with a
real-time web dashboard. It runs in two modes: **echo mode** for examining what
your client sends, and **proxy mode** for transparently forwarding requests
upstream while recording both sides of the conversation.

---

## Install

```bash
npm install -g @johnhenry/prism
```

## Quick Start

```bash
# Echo mode -- capture and inspect requests
prism --port 4568
curl http://localhost:4568/hello
# Open http://localhost:4568/inspect/ for the dashboard

# Proxy mode -- forward to an upstream, capture requests and responses
prism --port 4568 --target https://httpbin.org
curl http://localhost:4568/get

# Proxy with auth injection
prism --port 4568 --target https://api.example.com --bearer-token sk-abc123

# Multi-target proxying
prism --port 4568 \
  --target-map '{ "/api": "https://api.example.com", "/auth": "https://auth.example.com" }'
```

The dashboard is served at `http://localhost:PORT/inspect/`.

---

## Modes

### Echo Mode (default)

When no `--target` is provided, Prism captures every inbound request and
responds with a JSON summary containing the raw HTTP, cURL, fetch code, parsed
headers, and body. Useful for verifying exactly what a client sends.

### Proxy Mode

When `--target` (or `--target-map`) is set, Prism captures the request, forwards
it upstream, and captures the response. The response is returned to the caller
transparently. In addition to request data, proxy mode records:

- Response status, headers, and body
- Socket-level timing (DNS, connect, TLS, TTFB, transfer)
- Rate limit headers (`x-ratelimit-*`, `ratelimit-*`, `retry-after`)

---

## CLI Reference

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--port` | `-p` | `PORT` env or `3000` | Listen port |
| `--target` | `-t` | `TARGET` env | Upstream URL for proxy mode |
| `--target-map` | | | JSON map of path prefixes to upstream URLs |
| `--max-history` | | `200` | Maximum captured entries to retain |
| `--max-body-size` | | `1048576` (1 MB) | Maximum request/response body bytes to capture |
| `--storage` | | `~/.prism/history.jsonl` | Path to the JSONL persistence file |
| `--no-persist` | | `false` | Disable persistence entirely |
| `--bearer-token` | | | Inject `Authorization: Bearer <token>` on upstream requests |
| `--api-key` | | | Inject an API key header on upstream requests |
| `--api-key-header` | | `x-api-key` | Header name used for `--api-key` |
| `--basic-auth` | | | `user:pass` for upstream Basic authentication |
| `--help` | `-h` | | Print usage information and exit |

---

## Dashboard

The web dashboard is served at `/inspect/` and provides five pages. In echo
mode, proxy-only features (status filter, rewrite rules, response tabs, timing
waterfall) are automatically hidden.

### Capture (`/inspect/`)

Live feed of captured requests streamed over SSE. Each entry expands to show:

- Raw HTTP, cURL command, fetch() code, HAR entry
- Request body (parsed by content type)
- Structured headers (RFC 8941)
- Response headers and body (proxy mode)
- Timing waterfall (proxy mode)
- Rate limit summary (proxy mode)

Toolbar features: filter by method, status code (proxy), path regex, and
full-text search. Pin entries to keep them visible. Compose new requests with
the Build panel (method, path, headers, body) or paste a cURL command. Export
all captured entries as HAR, a cURL shell script, or a fetch ESM module.

### Analyze (`/inspect/diff`)

Side-by-side diff of any two captured requests. Compare in HTTP, cURL, or
fetch format.

### Rewrite Rules (`/inspect/transform`) -- proxy mode only

Create, view, and delete URL rewrite rules that modify proxied requests and
responses on the fly. Match by path prefix or regex and HTTP method. Available
actions: set headers, remove headers, rewrite path, override response status.

### Configure (`/inspect/settings`)

Read-only display of the running configuration: mode, target, capture count,
max history, max body size, persistence status, and server uptime.

### WebSockets (`/inspect/ws`)

Live inspector for WebSocket frames flowing through the proxy. Displays
bidirectional frames (client-to-server and server-to-client) with timestamps
and payload previews.

### Custom Routes (`/inspect/routes`)

Define routes that don't fall through to capture/proxy behavior: a script
route runs a JavaScript handler (sandboxed via `@johnhenry/andbox`, with
`context.params`/`context.query` and a captured `console.log` output),
a static route serves a directory or an uploaded archive, and a proxy route
forwards to a specific upstream.

---

## API Reference

All API endpoints are mounted under the inspector path (default `/inspect/`).

### Server-Sent Events

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/events` | SSE stream of all captured requests |
| `GET` | `/events/errors` | SSE stream of error-status requests only (status >= 400) |
| `GET` | `/events/ws` | SSE stream of WebSocket frames |

### History and Entries

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/history` | Full JSON array of all captured entries |
| `GET` | `/history/summary` | Lightweight summary: id, method, path, status, timestamp |
| `GET` | `/entry/:id` | Single entry by ID |
| `GET` | `/health` | Health check and configuration JSON |

### Replay and Import

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/replay/:id` | Replay a previously captured request |
| `POST` | `/import/curl` | Import a cURL command as a captured entry |

### Export

| Method | Path | Response |
|--------|------|----------|
| `GET` | `/export/har` | HAR 1.2 JSON file download |
| `GET` | `/export/curl` | Shell script with one cURL command per entry |
| `GET` | `/export/fetch` | ESM module with one fetch() call per entry |

### Rewrite Rules

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/rules` | List all rewrite rules |
| `POST` | `/rules` | Add a rewrite rule (JSON body) |
| `DELETE` | `/rules/:index` | Delete a rewrite rule by index |

### Custom Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/routes` | List all custom routes |
| `POST` | `/routes` | Add a custom route (JSON body: `{match: {path, method?}, type, ...}`) |
| `PUT` | `/routes/:index` | Replace a custom route by index |
| `DELETE` | `/routes/:index` | Delete a custom route by index |
| `POST` | `/routes/upload-archive` | Add a static route backed by an uploaded archive |
| `GET` | `/routes/:index/export` | Export a static route's files as an archive |

### WebSocket Connections

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/ws/connections` | List active WebSocket proxy connections |

### Static and Catch-All

Any path that does not match an API route is first checked against the static
dashboard files. If no static file matches, custom routes are checked next
(script, static, or proxy). If nothing matches, the request is treated as a
capture target (echo or proxy depending on mode).

---

## Architecture

```
server.mjs          Entry point. Parses CLI config, mounts the inspector
                    router at /inspect, redirects / to /inspect/.

cli.mjs             CLI argument parser (node:util parseArgs). Merges flags
                    with environment variables and returns a config object.

inspector.mjs       Core module. Creates a letterpress router with all API
                    endpoints, SSE feeds (via signalle), request capture,
                    proxy forwarding, export generation, and rewrite rules.

injected-console.mjs  console.log/warn/error capture for sandboxed script
                    routes, passed into @johnhenry/andbox as the `console`
                    global.

timed-fetch.mjs     Low-level HTTP client wrapping node:http/node:https.
                    Hooks into socket events (lookup, connect, secureConnect)
                    to produce DNS/connect/TLS/TTFB/transfer timings.

ws-proxy.mjs        Bidirectional WebSocket proxy. Connects a client socket
                    to an upstream socket and emits per-frame events for the
                    dashboard inspector.

storage.mjs         JSONL append-only persistence with auto-compaction.
                    Entries are appended one per line; the file is rewritten
                    when it exceeds 1.5x maxEntries.

public/             Static assets for the web dashboard (HTML, CSS, JS).
```

### Dependencies

```bash
npm install -g @johnhenry/prism
```

| Package | Role |
|---------|------|
| [`@johnhenry/leserve`](https://github.com/johnhenry/leserve) | HTTP server with Web API handler pattern |
| [`@johnhenry/letterpress`](https://github.com/johnhenry/letterpress) | URL router, route templates, rewrite engine |
| [`@johnhenry/packfile`](https://github.com/johnhenry/packfile) | Directory/archive static file serving |
| [`@johnhenry/signalle`](https://github.com/johnhenry/signalle) | Reactive signals and SSE streaming |
| [`@johnhenry/http-fields`](https://github.com/johnhenry/http-fields) | RFC 8941 structured header parsing |
| [`@johnhenry/http-converter`](https://github.com/johnhenry/http-converter) | Format conversions: HAR, cURL, fetch code |
| [`@johnhenry/andbox`](https://github.com/johnhenry/andbox) | Sandboxed execution for custom script routes |
| [`@johnhenry/webwire`](https://github.com/johnhenry/webwire) | Node<->Web `Request`/`Response` conversion (`timed-fetch.mjs`'s connection options) |

---

## Persistence

Captured entries are persisted to a JSONL file (one JSON object per line) at
`~/.prism/history.jsonl` by default. The storage layer is append-only for
durability and automatically compacts the file when it grows beyond 1.5 times
the configured `--max-history`. Disable persistence entirely with `--no-persist`.

Custom routes registered via the dashboard/API persist to `~/.prism/routes.json`
by default when `--routes` (or the equivalent config) points at a path.

---

## Family

Prism is a showcase/integration app for the rest of the `@johnhenry` HTTP
family -- the table above names each dependency's specific role. Two are
worth calling out on their own terms, since porting Prism is what surfaced
real gaps in both:

- **[`@johnhenry/letterpress`](https://github.com/johnhenry/letterpress)** --
  Prism's router. Porting Prism found and closed two genuine migration gaps
  left over from letterpress's own rename from `leroute`: `router.mount()`
  (and the `ctx`-forwarding it depends on) and `createRewriter` (exposed as
  `@johnhenry/letterpress/rewrite`).
- **[`@johnhenry/leserve`](https://github.com/johnhenry/leserve)** -- Prism's
  server. Porting Prism found and closed a similar gap: `toWebResponse`,
  exposed as `@johnhenry/leserve/node-to-web`, for converting a Node
  client-response (`http.request()`'s callback argument) into a Web
  `Response`, which proxy mode needs when forwarding to an upstream.

## License

MIT
