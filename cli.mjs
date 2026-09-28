import { parseArgs } from "node:util";

/**
 * Parse CLI arguments and environment variables into a config object.
 * @returns {Object} config
 */
export const parseConfig = () => {
  const { values } = parseArgs({
    options: {
      port: { type: "string", short: "p", default: process.env.PORT || "3000" },
      target: { type: "string", short: "t", default: process.env.TARGET || "" },
      "target-map": { type: "string", default: "" },
      "max-history": { type: "string", default: "200" },
      "max-body-size": { type: "string", default: "1048576" },
      storage: { type: "string", default: "" },
      "no-persist": { type: "boolean", default: false },
      "bearer-token": { type: "string", default: "" },
      "api-key": { type: "string", default: "" },
      "api-key-header": { type: "string", default: "x-api-key" },
      "basic-auth": { type: "string", default: "" },
      routes: { type: "string", default: "" },
      openapi: { type: "string", default: "" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
  Usage: node server.mjs [options]

  Options:
    --port, -p          Port to listen on (default: 3000)
    --target, -t        Upstream URL for proxy mode
    --target-map        JSON map of path prefixes to upstream URLs
                        e.g. '{ "/api": "http://localhost:4000", "/auth": "http://localhost:5000" }'
    --max-history       Maximum entries to keep (default: 200)
    --max-body-size     Maximum body size to capture in bytes (default: 1048576 = 1MB)
    --storage           Path to history.jsonl file (default: ~/.prism/history.jsonl)
    --no-persist        Disable persistence
    --bearer-token      Inject Authorization: Bearer header on upstream requests
    --api-key           Inject API key header on upstream requests
    --api-key-header    Custom header name for api-key (default: x-api-key)
    --basic-auth        user:pass for upstream Basic auth
    --routes            Path to routes.json file (default: ~/.prism/routes.json)
    --openapi           Path to OpenAPI spec JSON (deferred)
    --help, -h          Show this help text
`);
    process.exit(0);
  }

  let targets = null;
  if (values["target-map"]) {
    try {
      targets = JSON.parse(values["target-map"]);
    } catch (e) {
      console.error("Error: --target-map must be valid JSON");
      process.exit(1);
    }
  }

  const homeDir = process.env.HOME || process.env.USERPROFILE || ".";
  const defaultStoragePath = `${homeDir}/.prism/history.jsonl`;
  const defaultRoutesPath = `${homeDir}/.prism/routes.json`;

  return {
    port: parseInt(values.port, 10),
    target: values.target || null,
    targets,
    maxHistory: parseInt(values["max-history"], 10),
    maxBodySize: parseInt(values["max-body-size"], 10),
    storagePath: values.storage || defaultStoragePath,
    persist: !values["no-persist"],
    bearerToken: values["bearer-token"] || null,
    apiKey: values["api-key"] || null,
    apiKeyHeader: values["api-key-header"],
    basicAuth: values["basic-auth"] || null,
    routesPath: values.routes || defaultRoutesPath,
    openapi: values.openapi || null,
  };
};
