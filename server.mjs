import { serve } from "@johnhenry/leserve";
import { createRouter } from "@johnhenry/letterpress";
import { createInspector } from "./inspector.mjs";
import { parseConfig } from "./cli.mjs";

const config = parseConfig();
const router = createRouter();

router.mount("/inspect", await createInspector(config));

// Redirect root to inspector dashboard
router.endpoint`GET /`(() => {
  return new Response(null, {
    status: 302,
    headers: { location: "/inspect/" },
  });
});

const routeLabel = config.routesPath ? ' + routes' : '';
const targetLabel = (config.targets
  ? `multi-target (${Object.keys(config.targets).length} routes)`
  : config.target
    ? `proxy → ${config.target}`
    : "echo") + routeLabel;

serve(
  {
    port: config.port,
    onListen: ({ path }) => {
      console.log(`
  ╭───────────────────────────────────────────╮
  │                                           │
  │   ◆ P R I S M                             │
  │   Live HTTP Request Inspector             │
  │   Mode: ${targetLabel.padEnd(33)}│
  │                                           │
  │   Dashboard  → ${(path + "inspect/").padEnd(25)}│
  │   Inspect    → ${(path + "inspect/anything").padEnd(25)}│
  │   SSE Feed   → ${(path + "inspect/events").padEnd(25)}│
  │   Errors     → ${(path + "inspect/events/errors").padEnd(25)}│
  │                                           │
  │   Try it:                                 │
  │   curl ${path}inspect/hello               │
  │                                           │
  ╰───────────────────────────────────────────╯
`);
    },
  },
  router
);
