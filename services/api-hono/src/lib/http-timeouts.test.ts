import { createServer } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { configureHttpIdleTimeout, getHttpServerOptions } from "./http-timeouts.js";

describe("getHttpServerOptions", () => {
  it("bounds incomplete headers, request bodies and idle sockets", () => {
    const options = getHttpServerOptions({
      LIBRIS_HTTP_HEADERS_TIMEOUT_MS: 1_000,
      LIBRIS_HTTP_REQUEST_TIMEOUT_MS: 2_000,
      LIBRIS_HTTP_IDLE_TIMEOUT_MS: 3_000,
    });

    expect(options).toMatchObject({
      headersTimeout: 1_000,
      requestTimeout: 2_000,
      connectionsCheckingInterval: 1_000,
    });
  });

  it("sets the idle socket timeout", () => {
    const server = createServer();
    configureHttpIdleTimeout(server, {
      LIBRIS_HTTP_HEADERS_TIMEOUT_MS: 1_000,
      LIBRIS_HTTP_REQUEST_TIMEOUT_MS: 2_000,
      LIBRIS_HTTP_IDLE_TIMEOUT_MS: 3_000,
    });

    expect(server.timeout).toBe(3_000);
    server.close();
  });
});
