import { createServer, get, type RequestListener, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { getHttpServerOptions } from "./http-timeouts.js";

/**
 * Deliberately small so the timing tests stay fast. Production defaults are
 * 10 s / 30 s / 30 s; only the relationships between them matter here.
 */
const ENV = {
  LIBRIS_HTTP_HEADERS_TIMEOUT_MS: 400,
  LIBRIS_HTTP_REQUEST_TIMEOUT_MS: 5_000,
  LIBRIS_HTTP_IDLE_TIMEOUT_MS: 300,
} as const;

let server: Server | null = null;

afterEach(async () => {
  if (!server) return;
  const closing = server;
  server = null;
  closing.closeAllConnections();
  await new Promise<void>((resolve) => closing.close(() => resolve()));
});

/** Start a server configured exactly as production is, and return its port. */
async function listen(handler: RequestListener): Promise<number> {
  const started = createServer(getHttpServerOptions(ENV), handler);
  server = started;
  await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
  return (started.address() as AddressInfo).port;
}

describe("getHttpServerOptions", () => {
  it("bounds incomplete headers, request bodies and idle keep-alive gaps", () => {
    const options = getHttpServerOptions({
      LIBRIS_HTTP_HEADERS_TIMEOUT_MS: 1_000,
      LIBRIS_HTTP_REQUEST_TIMEOUT_MS: 2_000,
      LIBRIS_HTTP_IDLE_TIMEOUT_MS: 3_000,
    });

    expect(options).toMatchObject({
      headersTimeout: 1_000,
      requestTimeout: 2_000,
      // The idle budget is now keep-alive only: it starts after a response is
      // written and bounds the wait for the NEXT request on that connection.
      keepAliveTimeout: 3_000,
      connectionsCheckingInterval: 1_000,
    });
  });

  it("leaves the whole-connection inactivity timeout disabled", async () => {
    // `server.timeout` is the one that counts handler execution as inactivity.
    // Node defaults it to 0 for exactly that reason, and nothing may turn it
    // back on. This is the structural half of what the timing test below
    // proves behaviourally; it fails immediately if `configureHttpIdleTimeout`
    // is ever reintroduced.
    await listen((_req, res) => res.end("ok"));

    expect(server?.timeout).toBe(0);
    expect(server?.keepAliveTimeout).toBe(ENV.LIBRIS_HTTP_IDLE_TIMEOUT_MS);
  });
});

describe("a handler slower than the idle deadline", () => {
  it("still answers, instead of resetting the connection", async () => {
    // libris-59m.28. The old `server.setTimeout(idleMs, socket =>
    // socket.destroy())` armed a socket INACTIVITY timer across the whole life
    // of the connection, handler execution included, and destroyed the socket
    // unconditionally when it fired. A legitimately slow request — an uncached
    // cover proxied from a sluggish CDN, a large multi-file upload — was killed
    // mid-flight and the client saw ECONNRESET rather than any HTTP status,
    // with nothing in the access log, while the handler carried on and later
    // wrote into a dead socket.
    //
    // The handler here takes four times the configured idle deadline. Against
    // the old code the client's request emitted ECONNRESET at ~idleMs and this
    // promise rejected instead of resolving.
    const handlerMs = ENV.LIBRIS_HTTP_IDLE_TIMEOUT_MS * 4;
    const port = await listen((_req, res) => {
      setTimeout(() => res.end("slow but honest"), handlerMs);
    });

    const startedAt = Date.now();
    const { status, body } = await new Promise<{ status?: number; body: string }>(
      (resolve, reject) => {
        get({ host: "127.0.0.1", port, path: "/" }, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            text += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode, body: text }));
        }).on("error", reject);
      },
    );

    expect(status).toBe(200);
    expect(body).toBe("slow but honest");
    // And it really did outlive the deadline rather than being answered early.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(ENV.LIBRIS_HTTP_IDLE_TIMEOUT_MS);
  });
});

describe("slowloris protection", () => {
  it("still closes a client that never finishes sending its headers", async () => {
    // The receive-side bound is what the original hardening was about, and it
    // has to survive the fix above. This socket sends a request line and one
    // header, then dribbles forever, never sending the blank line that ends the
    // header block, so the handler is never reached.
    const port = await listen((_req, res) => res.end("ok"));

    const startedAt = Date.now();
    const { elapsed, response } = await new Promise<{ elapsed: number; response: string }>(
      (resolve, reject) => {
        const socket = connect(port, "127.0.0.1", () => {
          socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n");
        });
        const giveUp = setTimeout(() => {
          socket.destroy();
          reject(new Error("the server never closed the half-sent request"));
        }, 4_000);
        // The socket has to be flowing, or the client never processes the
        // server's FIN and "close" would not fire even after it was cut off.
        let received = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          received += chunk;
        });
        // A reset is a legitimate way for the server to end this.
        socket.on("error", () => {});
        socket.on("close", () => {
          clearTimeout(giveUp);
          resolve({ elapsed: Date.now() - startedAt, response: received });
        });
      },
    );

    expect(response).toContain("408 Request Timeout");
    // headersTimeout is enforced on connectionsCheckingInterval ticks, so allow
    // roughly two of them; the point is that it is bounded at all.
    expect(elapsed).toBeLessThan(ENV.LIBRIS_HTTP_HEADERS_TIMEOUT_MS * 2 + 1_000);
  });
});
