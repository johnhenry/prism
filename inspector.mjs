import { createRouter, createRoute } from "@johnhenry/letterpress";
import { signal, computed } from "@johnhenry/signalle";
import { toSSEResponse } from "@johnhenry/signalle/stream";
import { allFormats } from "@johnhenry/http-converter";
import * as curlMod from "@johnhenry/http-converter/curl";
import * as harMod from "@johnhenry/http-converter/har";
import { parseAuto } from "@johnhenry/http-fields";
import { fromDirectory, fromArchive, toArchive, createRouter as createStaticRouter } from "@johnhenry/packfile";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseBody } from "@johnhenry/http-converter/body";
import { timedFetch } from "./timed-fetch.mjs";
import { toWebResponse } from "@johnhenry/leserve/node-to-web";
import { createStorage } from "./storage.mjs";
import { createRewriter } from "@johnhenry/letterpress/rewrite";
import { json as parseJSON, respond, error as errorResponse } from "@johnhenry/leserve/body";
import { createSandbox } from "@johnhenry/andbox";
import { InjectedConsole } from "./injected-console.mjs";
import { createRouteStorage } from "./route-storage.mjs";

const PUBLIC_DIR = new URL("./public/", import.meta.url).pathname;
const files = await fromDirectory(PUBLIC_DIR);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const resolveTarget = (path, target, targets) => {
  if (typeof target === "string" && target) return target;
  if (targets) {
    const prefix = Object.keys(targets)
      .sort((a, b) => b.length - a.length)
      .find((p) => path.startsWith(p));
    return prefix ? targets[prefix] : null;
  }
  return null;
};

const injectAuth = (headers, authConfig) => {
  const h = new Headers(headers);
  if (authConfig.bearerToken)
    h.set("authorization", `Bearer ${authConfig.bearerToken}`);
  if (authConfig.apiKey)
    h.set(authConfig.apiKeyHeader || "x-api-key", authConfig.apiKey);
  if (authConfig.basicAuth) {
    const encoded =
      typeof btoa === "function"
        ? btoa(authConfig.basicAuth)
        : Buffer.from(authConfig.basicAuth).toString("base64");
    h.set("authorization", `Basic ${encoded}`);
  }
  return h;
};

const detectRateLimit = (headers) => {
  const get = (name) => {
    for (const [k, v] of headers) {
      if (k.toLowerCase() === name) return v;
    }
    return null;
  };

  const limit =
    get("x-ratelimit-limit") || get("ratelimit-limit");
  const remaining =
    get("x-ratelimit-remaining") || get("ratelimit-remaining");
  const reset =
    get("x-ratelimit-reset") || get("ratelimit-reset");
  const retryAfter = get("retry-after");

  if (!limit && !remaining && !reset && !retryAfter) return null;
  return {
    limit: limit ? parseInt(limit, 10) : null,
    remaining: remaining ? parseInt(remaining, 10) : null,
    reset: reset || null,
    retryAfter: retryAfter || null,
  };
};


// ---------------------------------------------------------------------------
// Safe globals for user route-script execution (via @johnhenry/andbox)
// ---------------------------------------------------------------------------
const SAFE_GLOBALS = {
  JSON, Math, Date, URL, URLSearchParams, TextEncoder, TextDecoder,
  Array, Object, Map, Set, WeakMap, WeakSet, Promise,
  parseInt, parseFloat, isNaN, isFinite, Number, String, Boolean,
  Symbol, BigInt, RegExp, Error, TypeError, RangeError, SyntaxError,
  encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
  atob, btoa, structuredClone,
  Response, Headers, Request,
  console: undefined, // will be replaced per-execution
};

// ---------------------------------------------------------------------------
// Archive helpers
// ---------------------------------------------------------------------------
const ARCHIVES_DIR = join(homedir(), ".prism", "archives");
const INLINE_THRESHOLD = 256 * 1024; // 256 KB

const buildStaticRouter = async (route) => {
  let files;
  if (route.directory) {
    files = await fromDirectory(route.directory);
  } else if (route.archive) {
    const buf = await readFile(route.archive);
    files = await fromArchive(buf);
  } else if (route.archiveData) {
    const buf = Buffer.from(route.archiveData, "base64");
    files = await fromArchive(buf);
  } else {
    return null;
  }
  return createStaticRouter(files);
};

const loadStaticFiles = async (route) => {
  if (route.directory) {
    return fromDirectory(route.directory);
  } else if (route.archive) {
    const buf = await readFile(route.archive);
    return fromArchive(buf);
  } else if (route.archiveData) {
    const buf = Buffer.from(route.archiveData, "base64");
    return fromArchive(buf);
  }
  return null;
};

// ---------------------------------------------------------------------------
// Path compilation for route matching
// ---------------------------------------------------------------------------
const compilePath = (pattern) => {
  const keys = [];
  const hasParams = pattern.includes(":");
  if (!hasParams) {
    // Prefix match for static routes
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { regex: new RegExp(`^${escaped}(?:/.*)?$`), keys };
  }
  // Convert :param segments to capture groups
  const parts = pattern.split("/").map((seg) => {
    if (seg.startsWith(":")) {
      keys.push(seg.slice(1));
      return "([^/]+)";
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return { regex: new RegExp(`^${parts.join("/")}(?:/.*)?$`), keys };
};

/**
 * Create a mountable HTTP inspector router.
 *
 * @param {Object} [options]
 * @param {string|null} [options.target] - Upstream URL for proxy mode
 * @param {Object|null} [options.targets] - Map of path prefixes → upstream URLs
 * @param {number} [options.maxHistory=200] - Maximum entries to keep
 * @param {number} [options.maxBodySize=1048576] - Maximum body bytes to capture
 * @param {boolean} [options.cors=true] - Enable CORS on SSE/JSON responses
 * @param {boolean} [options.persist=true] - Enable JSONL persistence
 * @param {string} [options.storagePath] - Path to history.jsonl
 * @param {string|null} [options.bearerToken] - Bearer token for upstream
 * @param {string|null} [options.apiKey] - API key for upstream
 * @param {string} [options.apiKeyHeader] - Header name for API key
 * @param {string|null} [options.basicAuth] - user:pass for upstream
 * @param {string} [options.routesPath] - Path to routes.json file
 * @returns {Function} A letterpress-compatible handler
 */
export const createInspector = async (options = {}) => {
  const {
    target = null,
    targets = null,
    maxHistory = 200,
    maxBodySize = 1048576,
    cors = true,
    persist = true,
    storagePath,
    bearerToken = null,
    apiKey = null,
    apiKeyHeader = "x-api-key",
    basicAuth = null,
    routesPath = null,
  } = options;

  const authConfig = { bearerToken, apiKey, apiKeyHeader, basicAuth };
  const hasAuth =
    Boolean(bearerToken) || Boolean(apiKey) || Boolean(basicAuth);
  const hasTarget = Boolean(target) || Boolean(targets);

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  const storage =
    persist && storagePath ? createStorage({ path: storagePath, maxEntries: maxHistory }) : null;

  // ---------------------------------------------------------------------------
  // Rewrite rules
  // ---------------------------------------------------------------------------
  const rewriter = createRewriter();

  // ---------------------------------------------------------------------------
  // Route storage & state
  // ---------------------------------------------------------------------------
  const routeStorage = routesPath
    ? createRouteStorage({ path: routesPath })
    : null;

  let routes = [];
  const staticRouters = new Map();
  const staticErrors = new Map(); // path → error message

  if (routeStorage) {
    try {
      routes = await routeStorage.load();
      // Pre-build static routers for existing static routes
      for (const route of routes) {
        if (route.type === "static" && (route.directory || route.archive || route.archiveData)) {
          try {
            const router = await buildStaticRouter(route);
            if (router) {
              staticRouters.set(route.match.path, router);
              staticErrors.delete(route.match.path);
            }
          } catch (err) {
            staticErrors.set(route.match.path, err.message);
          }
        }
      }
    } catch {
      // route storage load failure is non-fatal
    }
  }

  const matchRoute = (path, method) => {
    // Route patterns (route.match.path) are always pure paths, never
    // "?query"-bearing -- callers may pass a path+search string (the
    // capture feed's own display-oriented entry.path does), so strip any
    // query string before matching rather than requiring every caller to
    // pre-clean its input. Previously this leaked into the match itself:
    // for a static pattern, a trailing "?..." meant compilePath's regex
    // never matched at all (silently falling through to capture/proxy
    // behavior); for a `:param` pattern, "?..." got silently absorbed into
    // the last param's value instead of being matched or rejected.
    const pathOnly = path.split("?")[0];
    for (const route of routes) {
      if (route.match.method && route.match.method !== method) continue;
      const { regex, keys } = compilePath(route.match.path);
      const m = pathOnly.match(regex);
      if (m) {
        const params = {};
        keys.forEach((key, i) => { params[key] = m[i + 1]; });
        return { route, params };
      }
    }
    return null;
  };

  const normalizeResult = (result) => {
    if (result instanceof Response) return result;
    if (typeof result === "string") {
      return new Response(result, { headers: { "content-type": "text/plain" } });
    }
    if (result && typeof result === "object") {
      if (result.status || result.headers || result.body) {
        return new Response(
          typeof result.body === "string" ? result.body : JSON.stringify(result.body),
          { status: result.status || 200, headers: result.headers || {} }
        );
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(null, { status: 204 });
  };

  const executeScriptRoute = async (route, request, params) => {
    const url = new URL(request.url, "http://localhost");
    const query = Object.fromEntries(url.searchParams);
    const injectedConsole = new InjectedConsole();

    const context = { params, query };

    // `inline` mode (same-thread AsyncFunction, no Worker) is the honest
    // match for what this route feature actually needs: vimble's own `run()`
    // never provided real isolation either (just a data: URL dynamic import
    // for scoping) -- andbox's `worker` mode would add a real isolation
    // boundary, but `request` (a live Fetch API Request with a body stream)
    // can't cross a Worker's structured-clone boundary the way this script
    // expects to use it directly. We supply our own `console` as an injected
    // global (same as vimble did) rather than andbox's own print()/onConsole
    // mechanism, so route scripts keep using plain `console.log(...)`.
    const sandbox = createSandbox({
      mode: "inline",
      globals: {
        ...SAFE_GLOBALS,
        console: injectedConsole,
        request: request.clone(),
        context,
      },
    });
    const { success, returnValue, error } = await sandbox.execute(route.script);
    if (!success) {
      throw new Error(error);
    }

    const logs = injectedConsole.output || null;
    return { response: normalizeResult(returnValue), logs };
  };

  const serveStaticRoute = async (route, request) => {
    const router = staticRouters.get(route.match.path);
    if (!router) {
      return errorResponse("Static directory not loaded", 500);
    }
    // Strip the route prefix from the URL path
    const url = new URL(request.url, "http://localhost");
    const subPath = url.pathname.slice(route.match.path.length) || "/";
    const subUrl = new URL(subPath + url.search, "http://localhost");
    const subRequest = new Request(subUrl, {
      method: request.method,
      headers: request.headers,
    });
    const res = await router(subRequest);
    return res || new Response("Not Found", { status: 404 });
  };

  const serveProxyRoute = async (route, request) => {
    const url = new URL(request.url, "http://localhost");
    const subPath = url.pathname.slice(route.match.path.length) || "/";
    const targetUrl = new URL(subPath + url.search, route.upstream);

    let bodyBuf = null;
    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      const cloned = request.clone();
      bodyBuf = Buffer.from(await cloned.arrayBuffer());
    }

    // Same fix as the main proxy-mode path above: don't forward the
    // incoming Host header (names this server, not route.upstream) --
    // breaks HTTPS targets whose cert doesn't cover it. See AGENTS.md.
    const proxyHeaders = new Headers(request.headers);
    proxyHeaders.set("host", targetUrl.host);

    const { response: nodeRes, body: resBody, timings } = await timedFetch(
      targetUrl.toString(),
      {
        method: request.method,
        headers: proxyHeaders,
        body: bodyBuf,
      }
    );

    const webResponse = toWebResponse(nodeRes, resBody);
    return { response: webResponse, timings, resBody };
  };

  // ---------------------------------------------------------------------------
  // Reactive state
  // ---------------------------------------------------------------------------
  const feed = signal({ id: 0, entries: [] });
  let nextId = 1;

  const errorFeed = computed(feed, (f) => ({
    ...f,
    entries: f.entries.filter((e) => e.status && e.status >= 400),
  }));

  // WebSocket feed
  const wsFeed = signal({ id: 0, connections: [] });

  // ---------------------------------------------------------------------------
  // Boot: load persisted entries
  // ---------------------------------------------------------------------------
  if (storage) {
    try {
      const loaded = await storage.load();
      if (loaded.length) {
        const entries = loaded.slice(-maxHistory);
        const maxId = entries.reduce((m, e) => Math.max(m, e.id || 0), 0);
        nextId = maxId + 1;
        feed.value = { id: maxId, entries };
      }
    } catch {
      // storage load failure is non-fatal
    }
  }

  // ---------------------------------------------------------------------------
  // Request capture
  // ---------------------------------------------------------------------------
  const captureRequest = async (request, { skipBody = false } = {}) => {
    const url = new URL(request.url);

    // Read body before allFormats cloning
    let bodyData = null;
    if (!skipBody && request.body && request.method !== "GET" && request.method !== "HEAD") {
      try {
        const cloned = request.clone();
        const raw = await cloned.text();
        if (raw && raw.length <= maxBodySize) {
          const ct = request.headers.get("content-type") || "";
          bodyData = parseBody(raw, ct);
        } else if (raw) {
          bodyData = { type: "truncated", formatted: `[Body truncated: ${raw.length} bytes]`, raw: "" };
        }
      } catch {
        // body unreadable
      }
    }

    const formats = await allFormats(request.clone(), {
      curl: { pretty: true },
      fetch: { async: true },
    });

    const structured = {};
    for (const [name, rawValue] of request.headers) {
      try {
        const { value, type } = parseAuto(rawValue);
        structured[name] = { value, type };
      } catch {
        // not a valid structured field
      }
    }

    return {
      id: nextId++,
      timestamp: new Date().toISOString(),
      method: request.method,
      path: url.pathname + url.search,
      remoteAddress: null,
      formats,
      structured,
      headerCount: [...request.headers].length,
      body: bodyData,
      status: null,
      statusText: null,
      responseHeaders: null,
      responseBody: null,
      timings: null,
      rateLimit: null,
    };
  };

  // ---------------------------------------------------------------------------
  // Push entry into feed + storage
  // ---------------------------------------------------------------------------
  const pushEntry = async (entry) => {
    const prev = feed.peek();
    const entries = [entry, ...prev.entries].slice(0, maxHistory);
    feed.value = { id: entry.id, entries };

    if (storage) {
      try {
        await storage.append(entry);
        // Compact if needed
        const currentEntries = feed.peek().entries;
        if (currentEntries.length > storage.maxEntries * 1.5) {
          await storage.compact(currentEntries);
        }
      } catch {
        // storage failure is non-fatal
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Catch-all handler: capture + echo or proxy
  // ---------------------------------------------------------------------------
  const handleCapture = async (request, ctx = {}) => {
    const entry = await captureRequest(request);
    const rawPath = entry.path; // un-prefixed path for route matching
    entry.path = (ctx.mountPrefix || "") + entry.path;
    entry.remoteAddress = ctx.remoteAddress || "unknown";

    let responseToReturn;

    // ── Check user-defined routes first ────────────────────────────
    const matched = matchRoute(rawPath, request.method);

    if (matched) {
      const { route, params } = matched;
      if (route.type === "script") {
        try {
          const { response, logs } = await executeScriptRoute(route, request, params);
          responseToReturn = response;
          entry.source = "route:script";
          entry.routeName = route.name;
          if (logs) entry.routeLogs = logs;
        } catch (err) {
          entry.source = "route:script";
          entry.routeName = route.name;
          entry.status = 500;
          responseToReturn = errorResponse(err.message, 500);
        }
      } else if (route.type === "static") {
        try {
          responseToReturn = await serveStaticRoute(route, request);
          entry.source = "route:static";
          entry.routeName = route.name;
        } catch (err) {
          entry.source = "route:static";
          entry.routeName = route.name;
          entry.status = 500;
          responseToReturn = errorResponse(err.message, 500);
        }
      } else if (route.type === "proxy") {
        try {
          const { response, timings, resBody } = await serveProxyRoute(route, request);
          responseToReturn = response;
          entry.source = "route:proxy";
          entry.routeName = route.name;
          entry.timings = timings;
          // Capture response body
          const resText = resBody.toString("utf-8");
          const resContentType = response.headers.get("content-type") || "";
          if (resText.length <= maxBodySize) {
            entry.responseBody = {
              text: resText,
              size: resBody.length,
              truncated: false,
              contentType: resContentType,
              parsed: parseBody(resText, resContentType),
            };
          }
        } catch (err) {
          entry.source = "route:proxy";
          entry.routeName = route.name;
          entry.status = 502;
          responseToReturn = new Response(
            JSON.stringify({ error: err.message }),
            { status: 502, headers: { "content-type": "application/json" } }
          );
        }
      }
      entry.status = responseToReturn.status;
      entry.statusText = responseToReturn.statusText;
      entry.responseHeaders = Object.fromEntries(responseToReturn.headers);
      // Apply response rewriting to route responses too
      responseToReturn = rewriter.rewriteResponse(responseToReturn, request);
    } else {
      const upstream = resolveTarget(entry.path, target, targets);

      if (upstream) {
      // ── Proxy mode ──────────────────────────────────────────────
      const url = new URL(request.url);
      const targetUrl = new URL(url.pathname + url.search, upstream);

      // Auth injection
      let proxyHeaders = hasAuth
        ? injectAuth(request.headers, authConfig)
        : new Headers(request.headers);
      // The incoming Host header names THIS server (e.g. "localhost:4568"),
      // not the upstream -- forwarding it unchanged breaks any HTTPS target
      // whose certificate doesn't cover that value (TLS hostname
      // verification fails: "Host: localhost. is not in the cert's
      // altnames"). Replace it with the upstream's own host so the outbound
      // request is addressed correctly. See AGENTS.md for how this was found.
      proxyHeaders.set("host", targetUrl.host);

      // Rewrite request
      let proxyRequest = new Request(targetUrl, {
        method: request.method,
        headers: proxyHeaders,
        body:
          request.method !== "GET" && request.method !== "HEAD"
            ? request.body
            : undefined,
        duplex: "half",
      });
      proxyRequest = rewriter.rewriteRequest(proxyRequest);

      try {
        // Read body for timedFetch
        let bodyBuf = null;
        if (proxyRequest.method !== "GET" && proxyRequest.method !== "HEAD" && proxyRequest.body) {
          const cloned = proxyRequest.clone();
          const ab = await cloned.arrayBuffer();
          bodyBuf = Buffer.from(ab);
        }

        const { response: nodeRes, body: resBody, timings } = await timedFetch(
          proxyRequest.url,
          {
            method: proxyRequest.method,
            headers: proxyRequest.headers,
            body: bodyBuf,
          }
        );

        entry.timings = timings;

        let webResponse = toWebResponse(nodeRes, resBody);

        // Rewrite response
        webResponse = rewriter.rewriteResponse(webResponse, request);

        entry.status = webResponse.status;
        entry.statusText = webResponse.statusText;
        entry.responseHeaders = Object.fromEntries(webResponse.headers);

        // Rate limit detection
        entry.rateLimit = detectRateLimit(webResponse.headers);

        // Capture response body
        const resText = resBody.toString("utf-8");
        const resContentType = webResponse.headers.get("content-type") || "";
        if (resText.length <= maxBodySize) {
          entry.responseBody = {
            text: resText,
            size: resBody.length,
            truncated: false,
            contentType: resContentType,
            parsed: parseBody(resText, resContentType),
          };
        } else {
          entry.responseBody = {
            text: "",
            size: resBody.length,
            truncated: true,
            contentType: resContentType,
            parsed: null,
          };
        }

        responseToReturn = new Response(resBody, {
          status: webResponse.status,
          statusText: webResponse.statusText,
          headers: webResponse.headers,
        });
      } catch (err) {
        entry.status = 502;
        entry.statusText = "Bad Gateway";
        responseToReturn = new Response(
          JSON.stringify({ error: "Upstream request failed", message: err.message }),
          {
            status: 502,
            headers: {
              "content-type": "application/json",
              ...(cors && { "access-control-allow-origin": "*" }),
            },
          }
        );
      }
    } else {
      // ── Echo mode ───────────────────────────────────────────────
      responseToReturn = new Response(
        JSON.stringify(
          {
            message: "Request captured!",
            id: entry.id,
            formats: entry.formats,
            structured: entry.structured,
            body: entry.body,
          },
          null,
          2
        ),
        {
          headers: {
            "content-type": "application/json",
            ...(cors && { "access-control-allow-origin": "*" }),
          },
        }
      );
    }
    } // close else (no matched route)

    await pushEntry(entry);
    return responseToReturn;
  };

  // ---------------------------------------------------------------------------
  // Router
  // ---------------------------------------------------------------------------
  const serveStatic = createStaticRouter(files, {
    alias: { "/": "index.html" },
    tryExtensions: [".html"],
    fallback: handleCapture,
  });

  const router = createRouter({
    defaultHandler: serveStatic,
  });

  // ── Route templates ──────────────────────────────────────────────
  // JSON route with CORS — auto-detects application/json from body
  const json = createRoute(
    cors ? { headers: { "access-control-allow-origin": "*" } } : {}
  );

  // ── SSE live event stream ───────────────────────────────────────
  router.endpoint`GET /events`(() => {
    return toSSEResponse(feed, {
      event: "request",
      transform: (val) => JSON.stringify(val),
      sendInitial: true,
      cors,
    });
  });

  router.endpoint`GET /events/errors`(() => {
    return toSSEResponse(errorFeed, {
      event: "request",
      transform: (val) => JSON.stringify(val),
      sendInitial: true,
      cors,
    });
  });

  router.endpoint`GET /events/ws`(() => {
    return toSSEResponse(wsFeed, {
      event: "ws",
      transform: (val) => JSON.stringify(val),
      sendInitial: true,
      cors,
    });
  });

  // ── JSON endpoints (using createRoute templates) ──────────────
  router.endpoint`GET /history`(
    json`${() => JSON.stringify(feed.peek().entries)}`
  );

  router.endpoint`GET /history/summary`(
    json`${() => JSON.stringify(
      feed.peek().entries.map((e) => ({
        id: e.id, method: e.method, path: e.path,
        status: e.status, timestamp: e.timestamp,
      }))
    )}`
  );

  router.endpoint`GET /entry/:id`(
    json`${(req, ctx) => {
      const id = parseInt(ctx.params.id, 10);
      const entry = feed.peek().entries.find((e) => e.id === id);
      if (!entry) { ctx.setStatus(404); return JSON.stringify({ error: "Not Found" }); }
      return JSON.stringify(entry);
    }}`
  );

  router.endpoint`GET /health`(
    json`${() => {
      const mode = (hasTarget ? "proxy" : "echo") + (routes.length ? "+routes" : "");
      return JSON.stringify({
        status: "ok",
        mode,
        target: target || undefined,
        targets: targets || undefined,
        captured: nextId - 1,
        uptime: process.uptime(),
        persist: Boolean(storage),
        maxHistory,
        maxBodySize,
        routes: routes.length,
        hasRoutes: routes.length > 0,
      });
    }}`
  );

  router.endpoint`GET /rules`(
    json`${() => JSON.stringify(rewriter.getRules())}`
  );

  router.endpoint`GET /ws/connections`(
    json`${() => JSON.stringify(wsFeed.peek().connections)}`
  );

  // ── Replay ──────────────────────────────────────────────────────
  router.endpoint`POST /replay/:id`(
    json`${async (req, ctx) => {
      const id = parseInt(ctx.params.id, 10);
      const entry = feed.peek().entries.find((e) => e.id === id);
      if (!entry) { ctx.setStatus(404); return JSON.stringify({ error: "Not Found" }); }
      try {
        const harReq = harMod.toRequest(entry.formats.har);
        const res = await fetch(harReq.url, {
          method: harReq.method,
          headers: harReq.headers,
          body: harReq.body || undefined,
        });
        const resBody = await res.text();
        return JSON.stringify({
          status: res.status, statusText: res.statusText,
          headers: Object.fromEntries(res.headers), body: resBody,
        });
      } catch (err) {
        ctx.setStatus(502);
        return JSON.stringify({ error: err.message });
      }
    }}`
  );

  // ── Export (HTTP template format — headers are declarative) ─────
  router.endpoint`GET /export/har`(
    createRoute()`HTTP/1.1 200 OK
Content-Type: application/json
Content-Disposition: attachment; filename="prism-export.har"

${() => {
      const entries = feed.peek().entries;
      return JSON.stringify({ log: {
        version: "1.2", creator: { name: "Prism", version: "0.1.0" },
        entries: entries.map((e) => e.formats.har),
      }}, null, 2);
    }}`
  );

  router.endpoint`GET /export/curl`(
    createRoute()`HTTP/1.1 200 OK
Content-Type: text/x-shellscript
Content-Disposition: attachment; filename="prism-export.sh"

${() => feed.peek().entries
      .map((e) => `# ${e.method} ${e.path} [#${e.id}]\n${e.formats.curl}`)
      .join("\n\n")}`
  );

  router.endpoint`GET /export/fetch`(
    createRoute()`HTTP/1.1 200 OK
Content-Type: application/javascript
Content-Disposition: attachment; filename="prism-export.mjs"

${() => feed.peek().entries
      .map((e) => `// ${e.method} ${e.path} [#${e.id}]\n${e.formats.fetchCode}`)
      .join("\n\n")}`
  );

  // ── Import cURL ────────────────────────────────────────────────
  router.endpoint`POST /import/curl`(
    json`${async (req, ctx) => {
      try {
        const curlCmd = await req.text();
        const parsed = curlMod.toRequest(curlCmd);
        const nativeReq = new Request(parsed.url, {
          method: parsed.method,
          headers: parsed.headers,
          body: parsed.body || undefined,
        });
        const entry = await captureRequest(nativeReq);
        entry.path = parsed.url;
        entry.remoteAddress = "import";
        await pushEntry(entry);
        return JSON.stringify(entry);
      } catch (err) {
        ctx.setStatus(400);
        return JSON.stringify({ error: err.message });
      }
    }}`
  );

  // ── Rewrite rules CRUD ─────────────────────────────────────────
  router.endpoint`POST /rules`(
    json`${async (req, ctx) => {
      try {
        const rule = await req.json();
        rewriter.addRule(rule);
        return JSON.stringify(rewriter.getRules());
      } catch (err) {
        ctx.setStatus(400);
        return JSON.stringify({ error: err.message });
      }
    }}`
  );

  router.endpoint`DELETE /rules/:index`(
    json`${(req, ctx) => {
      const idx = parseInt(ctx.params.index, 10);
      rewriter.removeRule(idx);
      return JSON.stringify(rewriter.getRules());
    }}`
  );

  // ── Routes CRUD ─────────────────────────────────────────────────
  router.endpoint`GET /routes`(
    json`${() => {
      const augmented = routes.map((r) => {
        if (r.type !== "static") return r;
        const loaded = staticRouters.has(r.match.path);
        const error = staticErrors.get(r.match.path) || null;
        return { ...r, _loaded: loaded, _error: error };
      });
      return JSON.stringify(augmented);
    }}`
  );

  router.endpoint`POST /routes`(
    json`${async (req, ctx) => {
      try {
        const route = await req.json();
        if (!route.match?.path) {
          ctx.setStatus(400);
          return JSON.stringify({ error: "match.path is required" });
        }
        if (!route.type) route.type = "script";
        // Validate static route source fields
        if (route.type === "static") {
          const sources = [route.directory, route.archive, route.archiveData].filter(Boolean);
          if (sources.length === 0) {
            ctx.setStatus(400);
            return JSON.stringify({ error: "Static routes require one of: directory, archive, archiveData" });
          }
          if (sources.length > 1) {
            ctx.setStatus(400);
            return JSON.stringify({ error: "Static routes must have exactly one of: directory, archive, archiveData" });
          }
        }
        if (route.type === "proxy") {
          if (!route.upstream) {
            ctx.setStatus(400);
            return JSON.stringify({ error: "Proxy routes require an upstream URL" });
          }
        }
        routes.push(route);
        if (routeStorage) await routeStorage.save(routes);
        // Build static router if needed
        if (route.type === "static") {
          try {
            const router = await buildStaticRouter(route);
            if (router) {
              staticRouters.set(route.match.path, router);
              staticErrors.delete(route.match.path);
            }
          } catch (err) {
            staticErrors.set(route.match.path, err.message);
          }
        }
        return JSON.stringify(routes);
      } catch (err) {
        ctx.setStatus(400);
        return JSON.stringify({ error: err.message });
      }
    }}`
  );

  router.endpoint`PUT /routes/:index`(
    json`${async (req, ctx) => {
      try {
        const idx = parseInt(ctx.params.index, 10);
        if (idx < 0 || idx >= routes.length) {
          ctx.setStatus(404);
          return JSON.stringify({ error: "Route not found" });
        }
        const route = await req.json();
        // Validate static route source fields
        if (route.type === "static") {
          const sources = [route.directory, route.archive, route.archiveData].filter(Boolean);
          if (sources.length === 0) {
            ctx.setStatus(400);
            return JSON.stringify({ error: "Static routes require one of: directory, archive, archiveData" });
          }
          if (sources.length > 1) {
            ctx.setStatus(400);
            return JSON.stringify({ error: "Static routes must have exactly one of: directory, archive, archiveData" });
          }
        }
        if (route.type === "proxy") {
          if (!route.upstream) {
            ctx.setStatus(400);
            return JSON.stringify({ error: "Proxy routes require an upstream URL" });
          }
        }
        const old = routes[idx];
        routes[idx] = route;
        if (routeStorage) await routeStorage.save(routes);
        // Rebuild static router if type/source changed
        if (route.type === "static") {
          try {
            const router = await buildStaticRouter(route);
            if (router) {
              staticRouters.set(route.match.path, router);
              staticErrors.delete(route.match.path);
            }
          } catch (err) {
            staticErrors.set(route.match.path, err.message);
          }
        } else if (old.type === "static") {
          staticRouters.delete(old.match.path);
          staticErrors.delete(old.match.path);
        }
        return JSON.stringify(routes);
      } catch (err) {
        ctx.setStatus(400);
        return JSON.stringify({ error: err.message });
      }
    }}`
  );

  router.endpoint`DELETE /routes/:index`(
    json`${async (req, ctx) => {
      const idx = parseInt(ctx.params.index, 10);
      if (idx < 0 || idx >= routes.length) {
        ctx.setStatus(404);
        return JSON.stringify({ error: "Route not found" });
      }
      const removed = routes.splice(idx, 1)[0];
      if (removed.type === "static") {
        staticRouters.delete(removed.match.path);
        staticErrors.delete(removed.match.path);
      }
      if (routeStorage) await routeStorage.save(routes);
      return JSON.stringify(routes);
    }}`
  );

  // ── Archive upload ──────────────────────────────────────────────
  router.endpoint`POST /routes/upload-archive`(
    json`${async (req, ctx) => {
      try {
        const buf = Buffer.from(await req.arrayBuffer());
        if (!buf.length) {
          ctx.setStatus(400);
          return JSON.stringify({ error: "Empty body" });
        }
        // Validate by parsing
        let files;
        try {
          files = await fromArchive(buf);
        } catch (e) {
          ctx.setStatus(400);
          return JSON.stringify({ error: "Invalid CBOR archive: " + e.message });
        }
        const fileCount = files.size;
        let totalSize = 0;
        for (const [, v] of files) totalSize += v.size || v.data.byteLength;

        const rawName = req.headers.get("x-archive-name") || "archive";
        const slug = rawName.replace(/\.cbor$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_");

        if (buf.length <= INLINE_THRESHOLD) {
          return JSON.stringify({
            mode: "inline",
            archiveData: buf.toString("base64"),
            fileCount,
            totalSize,
          });
        }
        // Write to disk
        await mkdir(ARCHIVES_DIR, { recursive: true });
        const archivePath = join(ARCHIVES_DIR, slug + ".cbor");
        await writeFile(archivePath, buf);
        return JSON.stringify({
          mode: "file",
          archive: archivePath,
          fileCount,
          totalSize,
        });
      } catch (err) {
        ctx.setStatus(500);
        return JSON.stringify({ error: err.message });
      }
    }}`
  );

  // ── Directory upload (from browser File System Access API) ─────
  router.endpoint`POST /routes/upload-files`(
    json`${async (req, ctx) => {
      try {
        const { name = "upload", files: fileEntries } = await req.json();
        if (!fileEntries || typeof fileEntries !== "object" || !Object.keys(fileEntries).length) {
          ctx.setStatus(400);
          return JSON.stringify({ error: "No files provided" });
        }
        const filesMap = new Map();
        for (const [path, base64] of Object.entries(fileEntries)) {
          const data = new Uint8Array(Buffer.from(base64, "base64"));
          filesMap.set(path, { data, size: data.byteLength });
        }
        const archiveBuf = Buffer.from(await toArchive(filesMap));
        const slug = name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const fileCount = filesMap.size;
        let totalSize = 0;
        for (const [, v] of filesMap) totalSize += v.size;

        if (archiveBuf.length <= INLINE_THRESHOLD) {
          return JSON.stringify({
            mode: "inline",
            archiveData: archiveBuf.toString("base64"),
            fileCount,
            totalSize,
          });
        }
        await mkdir(ARCHIVES_DIR, { recursive: true });
        const archivePath = join(ARCHIVES_DIR, slug + ".cbor");
        await writeFile(archivePath, archiveBuf);
        return JSON.stringify({
          mode: "file",
          archive: archivePath,
          fileCount,
          totalSize,
        });
      } catch (err) {
        ctx.setStatus(500);
        return JSON.stringify({ error: err.message });
      }
    }}`
  );

  // ── Archive export ─────────────────────────────────────────────
  router.endpoint`GET /routes/:index/export`(async (req, ctx) => {
    const idx = parseInt(ctx.params.index, 10);
    if (idx < 0 || idx >= routes.length) {
      return errorResponse("Route not found", 404);
    }
    const route = routes[idx];
    if (route.type !== "static") {
      return errorResponse("Not a static route", 400);
    }
    try {
      const files = await loadStaticFiles(route);
      if (!files) {
        return errorResponse("No files to export", 400);
      }
      const archiveBuf = await toArchive(files);
      const name = (route.name || "archive").replace(/[^a-zA-Z0-9_-]/g, "_");
      return new Response(archiveBuf, {
        status: 200,
        headers: {
          "content-type": "application/cbor",
          "content-disposition": `attachment; filename="${name}.cbor"`,
        },
      });
    } catch (err) {
      return errorResponse(err.message, 500);
    }
  });

  router.endpoint`POST /routes/test`(
    json`${async (req, ctx) => {
      try {
        const data = await req.json();
        const { script, method = "GET", path = "/", headers = {}, body = null } = data;
        if (!script) {
          ctx.setStatus(400);
          return JSON.stringify({ error: "script is required" });
        }
        const testRoute = { script, type: "script", match: { path } };
        const testUrl = new URL(path, "http://localhost");
        const testRequest = new Request(testUrl, {
          method,
          headers: new Headers(headers),
          body: method !== "GET" && method !== "HEAD" ? body : undefined,
        });
        const { response, logs } = await executeScriptRoute(testRoute, testRequest, {});
        const resBody = await response.text();
        return JSON.stringify({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: resBody,
          logs,
        });
      } catch (err) {
        ctx.setStatus(500);
        return JSON.stringify({ error: err.message });
      }
    }}`
  );

  // Expose wsFeed for ws-proxy integration
  router._wsFeed = wsFeed;

  return router;
};
