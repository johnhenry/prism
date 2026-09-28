import { WebSocket } from "ws";

let connIdCounter = 0;

/**
 * Create a bidirectional WebSocket proxy with frame logging.
 *
 * @param {Function} resolveTargetFn - (path) => upstream WS URL or null
 * @param {Function} onFrame - ({ connId, direction, type, data, timestamp }) => void
 * @returns {Function} wsHandler(clientWs, request)
 */
export const createWSProxy = (resolveTargetFn, onFrame) => {
  return (clientWs, request) => {
    const connId = ++connIdCounter;
    const url = new URL(request.url, "http://localhost");
    const upstream = resolveTargetFn(url.pathname);

    if (!upstream) {
      clientWs.close(4000, "No upstream target configured");
      return { connId, upstream: null };
    }

    // Convert http(s) target to ws(s)
    const wsTarget = upstream
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:");
    const wsUrl = new URL(url.pathname + url.search, wsTarget).toString();

    const upstreamWs = new WebSocket(wsUrl);
    let closed = false;

    const emitFrame = (direction, data) => {
      const type =
        typeof data === "string" ? "text" : data instanceof Buffer ? "binary" : "text";
      onFrame({
        connId,
        direction,
        type,
        data: typeof data === "string" ? data : data.toString("utf-8").slice(0, 4096),
        timestamp: new Date().toISOString(),
      });
    };

    upstreamWs.on("open", () => {
      // Forward client → upstream
      clientWs.on("message", (data) => {
        emitFrame("client→server", data);
        if (upstreamWs.readyState === WebSocket.OPEN) {
          upstreamWs.send(data);
        }
      });
    });

    // Forward upstream → client
    upstreamWs.on("message", (data) => {
      emitFrame("server→client", data);
      if (clientWs.readyState === 1 /* OPEN */) {
        clientWs.send(data);
      }
    });

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (upstreamWs.readyState === WebSocket.OPEN) upstreamWs.close();
      if (clientWs.readyState === 1) clientWs.close();
    };

    clientWs.on("close", cleanup);
    clientWs.on("error", cleanup);
    upstreamWs.on("close", cleanup);
    upstreamWs.on("error", cleanup);

    return { connId, upstream: wsUrl };
  };
};
