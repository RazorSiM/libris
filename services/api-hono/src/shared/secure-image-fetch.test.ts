import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  assertNotInternalUrl,
  fetchExternalImage,
  isBlockedAddress,
  type ResolvedAddress,
  type SecureImageFetchDependencies,
} from "./secure-image-fetch.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

function dependencies(
  responses: Array<{ status: number; headers?: Record<string, string>; body?: Buffer }>,
  addresses: Array<{ address: string; family: 4 | 6 }> = [{ address: "93.184.216.34", family: 4 }],
) {
  const resolve = vi.fn(async () => addresses);
  // Parameters are declared even though they go unused, so `mock.calls` stays
  // typed and assertions about what each hop was handed can be written.
  const request = vi.fn(
    async (_url: URL, _address: ResolvedAddress, _signal: AbortSignal, _maxBytes: number) => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      return { headers: {}, body: Buffer.alloc(0), ...response };
    },
  );
  return { resolve, request } satisfies SecureImageFetchDependencies;
}

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.0",
    "127.0.0.1",
    "100.64.0.1",
    "192.0.0.10",
    "198.18.0.1",
    "224.0.0.1",
    "::",
    "::1",
    "0:0:0:0:0:0:0:1",
    "fe80::1",
    "fe90::1",
    "fea0::1",
    "febf::1",
    "fc00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "2001:db8::1",
    "100:0:0:1::1",
    "2002:7f00:1::1",
    "3fff::1",
    "5f00::1",
  ])("blocks special-use address %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])(
    "allows public address %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );

  it("rejects image bodies beyond the configured size limit", async () => {
    const deps = dependencies([
      {
        status: 200,
        headers: { "content-type": "image/jpeg" },
        body: Buffer.concat([JPEG, Buffer.alloc(100)]),
      },
    ]);

    await expect(
      fetchExternalImage("https://covers.example/image", { maxBytes: 100 }, deps),
    ).rejects.toThrow(/exceeds/i);
  });
});

describe("fetchExternalImage", () => {
  it("rejects redirects to loopback and link-local without requesting them", async () => {
    for (const location of ["http://127.0.0.1/private", "http://169.254.169.254/latest"] as const) {
      const deps = dependencies([{ status: 302, headers: { location } }]);

      await expect(fetchExternalImage("https://covers.example/start", {}, deps)).rejects.toThrow(
        /blocked/i,
      );
      expect(deps.request).toHaveBeenCalledOnce();
    }
  });

  it("allows a blocked address only for an explicitly allowlisted origin", async () => {
    const deps = dependencies(
      [{ status: 200, headers: { "content-type": "image/jpeg" }, body: JPEG }],
      [{ address: "192.168.1.20", family: 4 }],
    );

    await expect(
      fetchExternalImage(
        "http://covers.lan:8080/cover.jpg",
        { allowedOrigins: ["http://covers.lan:8080"] },
        deps,
      ),
    ).resolves.toMatchObject({ contentType: "image/jpeg" });
  });

  it("does not extend an origin allowlist across redirects", async () => {
    const deps = dependencies(
      [{ status: 302, headers: { location: "http://admin.lan/private" } }],
      [{ address: "192.168.1.20", family: 4 }],
    );

    await expect(
      fetchExternalImage(
        "http://covers.lan:8080/cover.jpg",
        { allowedOrigins: ["http://covers.lan:8080"] },
        deps,
      ),
    ).rejects.toThrow(/blocked/i);
    expect(deps.request).toHaveBeenCalledOnce();
  });

  it("follows a legitimate redirect chain within the hop limit", async () => {
    const deps = dependencies([
      { status: 302, headers: { location: "/two" } },
      { status: 301, headers: { location: "https://cdn.example/final.jpg" } },
      { status: 200, headers: { "content-type": "image/jpeg" }, body: JPEG },
    ]);

    const result = await fetchExternalImage("https://covers.example/one", {}, deps);

    expect(result.data).toEqual(JPEG);
    expect(result.contentType).toBe("image/jpeg");
    expect(deps.request).toHaveBeenCalledTimes(3);
  });

  it("rejects redirect chains beyond the hop cap", async () => {
    const deps = dependencies(
      Array.from({ length: 6 }, (_, index) => ({
        status: 302,
        headers: { location: `/hop-${index + 1}` },
      })),
    );

    await expect(fetchExternalImage("https://covers.example/start", {}, deps)).rejects.toThrow(
      /redirect/i,
    );
    expect(deps.request).toHaveBeenCalledTimes(6);
  });

  it("pins the request to the validated answer instead of resolving during connection", async () => {
    const deps = dependencies([
      { status: 200, headers: { "content-type": "image/jpeg" }, body: JPEG },
    ]);
    deps.resolve
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);

    await fetchExternalImage("https://rebind.example/cover.jpg", {}, deps);

    expect(deps.resolve).toHaveBeenCalledOnce();
    expect(deps.request).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: "rebind.example" }),
      { address: "93.184.216.34", family: 4 },
      expect.any(AbortSignal),
      expect.any(Number),
    );
  });

  it.each([
    [{}, JPEG, /content-type/i],
    [{ "content-type": "text/plain" }, JPEG, /content-type/i],
    [{ "content-type": "image/jpeg" }, Buffer.from("not an image"), /signature/i],
    [{ "content-type": "image/png" }, JPEG, /does not match/i],
  ] as const)(
    "rejects missing, invalid, or dishonest image metadata",
    async (headers, body, error) => {
      const deps = dependencies([{ status: 200, headers, body }]);
      await expect(fetchExternalImage("https://covers.example/image", {}, deps)).rejects.toThrow(
        error,
      );
    },
  );
});

/**
 * `timeoutMs` bounds the WHOLE operation, not each hop.
 *
 * It used to be handed to `dependencies.request` inside the redirect loop, and
 * `defaultRequest` built a fresh `AbortSignal.timeout` from it on every call, so
 * the real ceiling was (maxRedirects + 1) x timeoutMs — 60 s for the cover proxy
 * and 180 s for the organize worker. The redirect-limit test above counts hops
 * and says nothing about elapsed time, which is exactly why this shipped.
 */
describe("the total time budget", () => {
  /** A dependency set whose every hop is a redirect that takes `hopMs`. */
  function slowRedirectChain(hopMs: number) {
    const resolve = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const request = vi.fn(
      (url: URL, _address: unknown, signal: AbortSignal) =>
        new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>(
          (resolveHop, rejectHop) => {
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", onAbort);
              resolveHop({
                status: 302,
                headers: { location: `${url.pathname}-next` },
                body: Buffer.alloc(0),
              });
            }, hopMs);
            function onAbort() {
              clearTimeout(timer);
              rejectHop(signal.reason as Error);
            }
            signal.addEventListener("abort", onAbort, { once: true });
          },
        ),
    );
    return { resolve, request } satisfies SecureImageFetchDependencies;
  }

  it("is not multiplied by the redirect limit", async () => {
    // Five permitted redirects at 80 ms each plus the original request is
    // 480 ms of hops against a 200 ms budget. Under the old per-hop timeout
    // every hop got its own fresh 200 ms, so the chain ran to completion and
    // failed with "Cover redirect limit exceeded" at ~480 ms. Now it is refused
    // at the deadline instead.
    const deps = slowRedirectChain(80);

    const startedAt = Date.now();
    await expect(
      fetchExternalImage("https://covers.example/start", { timeoutMs: 200 }, deps),
    ).rejects.toThrow(/exceeded 200ms/);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(400);
    // And it really was cut off mid-chain rather than allowed to finish.
    expect(deps.request.mock.calls.length).toBeLessThan(6);
  });

  it("hands every hop the same signal rather than a fresh per-hop deadline", async () => {
    const deps = dependencies([
      { status: 302, headers: { location: "/two" } },
      { status: 301, headers: { location: "https://cdn.example/final.jpg" } },
      { status: 200, headers: { "content-type": "image/jpeg" }, body: JPEG },
    ]);

    await fetchExternalImage("https://covers.example/one", {}, deps);

    const signals = deps.request.mock.calls.map((call) => call[2]);
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal === signals[0])).toBe(true);
  });

  it("bounds a DNS lookup that never answers", async () => {
    // `defaultResolve` calls getaddrinfo, which takes no AbortSignal and cannot
    // be cancelled — so the deadline is enforced by refusing to keep waiting.
    // Before this, a hostile authoritative nameserver added unbounded time to
    // each of the six hops, on top of the per-hop request timeout.
    const deps = {
      resolve: vi.fn(() => new Promise<never>(() => {})),
      request: vi.fn(async () => {
        throw new Error("must never be reached");
      }),
    } satisfies SecureImageFetchDependencies;

    const startedAt = Date.now();
    await expect(
      fetchExternalImage("https://slow-dns.example/cover.jpg", { timeoutMs: 150 }, deps),
    ).rejects.toThrow(/exceeded 150ms/);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(deps.request).not.toHaveBeenCalled();
  });
});

/**
 * The default `request`/`resolve` implementations, which every other test in
 * this file replaces with a mock — so the streaming byte cap, the signal wiring
 * and the DNS path had no coverage at all.
 */
describe("the default request and resolve implementations", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    const closing = server;
    server = null;
    closing.closeAllConnections();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  });

  /** A loopback origin, allowlisted so the SSRF guard lets the test through. */
  async function listen(
    handler: Parameters<typeof createServer>[1],
  ): Promise<{ origin: string; allowedOrigins: string[] }> {
    const started = createServer(handler);
    server = started;
    await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(started.address() as AddressInfo).port}`;
    return { origin, allowedOrigins: [origin] };
  }

  it("fetches and validates a real image over a real socket", async () => {
    const { origin, allowedOrigins } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(JPEG);
    });

    const result = await fetchExternalImage(`${origin}/cover.jpg`, { allowedOrigins });

    expect(result.contentType).toBe("image/jpeg");
    expect(result.data).toEqual(JPEG);
    expect(result.finalUrl).toBe(`${origin}/cover.jpg`);
  });

  it("stops reading once the body passes maxBytes", async () => {
    // The cap has to bite while STREAMING, not after the whole body is in
    // memory — the point of it is that an attacker cannot make the process
    // buffer a gigabyte by declaring a small Content-Length and sending more.
    const { origin, allowedOrigins } = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.write(JPEG);
      for (let i = 0; i < 200; i++) res.write(Buffer.alloc(1024));
      res.end();
    });

    await expect(
      fetchExternalImage(`${origin}/huge.jpg`, { allowedOrigins, maxBytes: 1024 }),
    ).rejects.toThrow(/exceeds 1024 bytes/);
  });

  it("aborts a hop that never answers, on the shared deadline", async () => {
    const { origin, allowedOrigins } = await listen(() => {
      // Accept the request and never respond.
    });

    const startedAt = Date.now();
    await expect(
      fetchExternalImage(`${origin}/hangs.jpg`, { allowedOrigins, timeoutMs: 200 }),
    ).rejects.toThrow(/exceeded 200ms/);

    expect(Date.now() - startedAt).toBeLessThan(1_500);
  });

  it("resolves a real hostname and refuses it when it lands on loopback", async () => {
    // Exercises defaultResolve's getaddrinfo path: "localhost" is not an IP
    // literal, so it goes through lookup(), and every answer is loopback.
    await expect(assertNotInternalUrl("http://localhost/whatever")).rejects.toThrow(/blocked/i);
  });
});
