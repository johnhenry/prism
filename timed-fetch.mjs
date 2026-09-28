import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { toNodeRequestOptions } from "@johnhenry/webwire";

/**
 * Perform an HTTP(S) request with timing hooks on socket events.
 *
 * Connection-options building (URL parsing, header normalization, https
 * vs. http selection) is @johnhenry/webwire's `toNodeRequestOptions()` --
 * this function's own genuine value is entirely the timing instrumentation
 * layered on top (socket lookup/connect/secureConnect events, response
 * buffering, TTFB/transfer/total marks), which webwire deliberately has no
 * opinion about (it returns plain connection data, not a live request, so
 * callers stay in control of exactly this kind of thing).
 *
 * @param {string|URL} url
 * @param {Object} [options] - Options compatible with http.request
 * @param {string} [options.method]
 * @param {Object|Headers} [options.headers]
 * @param {string|Buffer|null} [options.body]
 * @returns {Promise<{ response: import('http').IncomingMessage, body: Buffer, timings: Object }>}
 */
export const timedFetch = (url, options = {}) => {
  return new Promise((resolve, reject) => {
    const { isHTTPS, requestOptions } = toNodeRequestOptions(url, {
      method: options.method,
      headers: options.headers,
    });
    const doRequest = isHTTPS ? httpsRequest : httpRequest;

    const timings = {
      dns: -1,
      connect: -1,
      tls: -1,
      ttfb: -1,
      transfer: -1,
      total: -1,
    };

    const marks = { start: Date.now() };

    const req = doRequest(requestOptions, (res) => {
      marks.ttfb = Date.now();
      timings.ttfb = marks.ttfb - marks.start;

      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        marks.end = Date.now();
        timings.transfer = marks.end - marks.ttfb;
        timings.total = marks.end - marks.start;
        resolve({ response: res, body: Buffer.concat(chunks), timings });
      });
      res.on("error", reject);
    });

    req.on("socket", (socket) => {
      socket.on("lookup", () => {
        marks.dns = Date.now();
        timings.dns = marks.dns - marks.start;
      });
      socket.on("connect", () => {
        marks.connect = Date.now();
        timings.connect = marks.connect - (marks.dns || marks.start);
      });
      socket.on("secureConnect", () => {
        marks.tls = Date.now();
        timings.tls = marks.tls - (marks.connect || marks.start);
      });
    });

    req.on("error", reject);

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
};

