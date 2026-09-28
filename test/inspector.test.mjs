import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createInspector } from "../inspector.mjs";

// createInspector() with no `storagePath`/`routesPath` never touches disk
// (see inspector.mjs: `storage = persist && storagePath ? ... : null`),
// so these tests exercise the router directly with no real filesystem or
// network I/O -- no server process to spawn, no `~/.prism` pollution.

test("dashboard HTML is served at /", async () => {
  const router = await createInspector();
  const response = await router(new Request("http://localhost/"));
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /<!DOCTYPE html>/i);
});

test("echo mode captures a request and returns a JSON summary", async () => {
  const router = await createInspector();
  const response = await router(
    new Request("http://localhost/hello", { headers: { "x-test": "1" } })
  );
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.message, "Request captured!");
  assert.ok(data.formats?.httpString);
  assert.ok(data.formats?.curl);
});

test("GET /health reports configuration", async () => {
  const router = await createInspector();
  const response = await router(new Request("http://localhost/health"));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(typeof data, "object");
});

test("GET /history returns captured entries", async () => {
  const router = await createInspector();
  await router(new Request("http://localhost/one"));
  await router(new Request("http://localhost/two"));
  const response = await router(new Request("http://localhost/history"));
  const entries = await response.json();
  const paths = (Array.isArray(entries) ? entries : entries.entries).map(
    (e) => e.path
  );
  assert.ok(paths.includes("/one"));
  assert.ok(paths.includes("/two"));
});

test("custom script route runs via @johnhenry/andbox and sees context.params", async () => {
  const router = await createInspector();
  await router(
    new Request("http://localhost/routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        match: { path: "/greet/:name" },
        type: "script",
        script: "const { params } = context; return { greeting: `hi ${params.name}` };",
      }),
    })
  );

  const response = await router(new Request("http://localhost/greet/world"));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data, { greeting: "hi world" });
});

// Regression test for a known, pre-existing limitation (present in the
// original lestack source unchanged -- see AGENTS.md's gotchas) rather
// than a spec for desired behavior: `matchRoute` is called with the query
// string still attached to the path. For a `:param` segment, whose regex
// is `([^/]+)`, that string gets silently absorbed into the last param's
// value instead of being matched at all. If this test ever starts
// failing because the bug got fixed, update AGENTS.md and this test
// together, not just one.
test("KNOWN BUG: a query string leaks into a trailing :param's value instead of being stripped", async () => {
  const router = await createInspector();
  await router(
    new Request("http://localhost/routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        match: { path: "/greet/:name" },
        type: "script",
        script: "const { params } = context; return { name: params.name };",
      }),
    })
  );

  const response = await router(
    new Request("http://localhost/greet/world?loud=1")
  );
  const data = await response.json();
  assert.equal(data.name, "world?loud=1"); // should be "world"
});

test("custom script route's console.log output is captured in the entry's routeLogs", async () => {
  const router = await createInspector();
  await router(
    new Request("http://localhost/routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        match: { path: "/logs" },
        type: "script",
        script: "console.log('hello from sandbox'); return { ok: true };",
      }),
    })
  );
  await router(new Request("http://localhost/logs"));

  const historyResponse = await router(new Request("http://localhost/history"));
  const entries = await historyResponse.json();
  const list = Array.isArray(entries) ? entries : entries.entries;
  const entry = list.find((e) => e.path === "/logs");
  assert.equal(entry.source, "route:script");
  assert.match(entry.routeLogs, /hello from sandbox/);
});

test("a script route that throws surfaces as a 500, not an unhandled rejection", async () => {
  const router = await createInspector();
  await router(
    new Request("http://localhost/routes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        match: { path: "/boom" },
        type: "script",
        script: "throw new Error('boom');",
      }),
    })
  );
  const response = await router(new Request("http://localhost/boom"));
  assert.equal(response.status, 500);
});

// Regression tests for a real bug found while verifying the @johnhenry/webwire
// port of timed-fetch.mjs: proxy mode was forwarding the incoming request's
// own Host header (naming prism itself) straight through to the upstream,
// which breaks any HTTPS target whose cert doesn't cover that value. Both
// proxy paths (main --target mode, and a custom "type": "proxy" route) spin
// up a real local HTTP server as a fake upstream and confirm it receives its
// OWN host in the Host header, not the original request's -- unlike every
// other test in this file, this one needs real (if local-only) network I/O,
// since the bug is specifically about what actually goes out over the wire.
const withFakeUpstream = async (run) => {
  let capturedHost;
  const upstream = http.createServer((req, res) => {
    capturedHost = req.headers.host;
    res.end("ok");
  });
  await new Promise((resolve) => upstream.listen(0, resolve));
  const { port } = upstream.address();
  try {
    await run(`http://localhost:${port}`, () => capturedHost);
  } finally {
    upstream.close();
  }
};

test("proxy mode (--target) sends the upstream's own Host header, not the client's", async () => {
  await withFakeUpstream(async (target, getCapturedHost) => {
    const router = await createInspector({ target });
    await router(new Request("http://localhost:4568/hello", { headers: { host: "localhost:4568" } }));
    assert.equal(getCapturedHost(), new URL(target).host);
  });
});

test("a custom proxy route sends the upstream's own Host header, not the client's", async () => {
  await withFakeUpstream(async (target, getCapturedHost) => {
    const router = await createInspector();
    await router(
      new Request("http://localhost/routes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ match: { path: "/proxied" }, type: "proxy", upstream: target }),
      })
    );
    await router(new Request("http://localhost/proxied/hello", { headers: { host: "localhost:4568" } }));
    assert.equal(getCapturedHost(), new URL(target).host);
  });
});
