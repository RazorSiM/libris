import { describe, expect, it, vi } from "vite-plus/test";
import {
  fetchExternalImage,
  isBlockedAddress,
  type SecureImageFetchDependencies,
} from "./secure-image-fetch.js";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);

function dependencies(
  responses: Array<{ status: number; headers?: Record<string, string>; body?: Buffer }>,
  addresses: Array<{ address: string; family: 4 | 6 }> = [{ address: "93.184.216.34", family: 4 }],
) {
  const resolve = vi.fn(async () => addresses);
  const request = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected request");
    return { headers: {}, body: Buffer.alloc(0), ...response };
  });
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
      expect.any(Number),
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
