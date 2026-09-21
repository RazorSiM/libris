import { Hono } from "hono";
import { describe, expect, it } from "vite-plus/test";
import type { AppVariables } from "../context.js";
import type { Env } from "../env.js";
import { bodyLimitMiddleware } from "./body-limit.js";

const BOUNDARY = "----libris-test-boundary";

interface Part {
  name: string;
  filename?: string;
  value: string | Uint8Array;
}

/** A multipart body delivered as a chunked stream: no content-length. */
function chunkedMultipart(parts: readonly Part[], chunkSize = 4096): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    let header = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename) header += `; filename="${part.filename}"`;
    header += "\r\n";
    if (part.filename) header += "Content-Type: application/epub+zip\r\n";
    header += "\r\n";
    chunks.push(encoder.encode(header));
    chunks.push(typeof part.value === "string" ? encoder.encode(part.value) : part.value);
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${BOUNDARY}--\r\n`));

  const total = chunks.reduce((size, chunk) => size + chunk.byteLength, 0);
  const flat = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    flat.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < flat.byteLength; index += chunkSize) {
        controller.enqueue(flat.subarray(index, index + chunkSize));
      }
      controller.close();
    },
  });
}

function buildUploadApp(maxBytes = 1024, maxFiles = 2) {
  const app = new Hono<{ Variables: AppVariables }>();
  const env = {
    NODE_ENV: "test",
    LIBRIS_MAX_UPLOAD_BYTES: maxBytes,
    LIBRIS_MAX_UPLOAD_FILES: maxFiles,
  } as Env;

  app.use("*", async (c, next) => {
    c.set("env", env);
    await next();
  });
  app.use("*", bodyLimitMiddleware);
  app.post("/api/inbox/upload", async (c) => {
    const body = await c.req.parseBody({ all: true });
    return c.json({ ok: true, parts: Object.keys(body).length });
  });
  app.post("/api/other", async (c) => {
    await c.req.text();
    return c.json({ ok: true });
  });
  return app;
}

function chunkedRequest(path: string, body: ReadableStream<Uint8Array>) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
    body,
    duplex: "half",
  } as RequestInit);
}

describe("bodyLimitMiddleware", () => {
  it("refuses an upload whose declared content-length is over the cap", async () => {
    const app = buildUploadApp(1024);
    const request = new Request("http://localhost/api/inbox/upload", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "999999" },
      body: "{}",
    });

    const response = await app.request(request);
    expect(response.status).toBe(413);
  });

  it("aborts a chunked upload once the cap is passed", async () => {
    const app = buildUploadApp(1024);
    const body = chunkedMultipart([
      { name: "file", filename: "big.epub", value: new Uint8Array(8 * 1024) },
    ]);

    const response = await app.request(chunkedRequest("/api/inbox/upload", body));
    expect(response.status).toBe(413);
  });

  it("counts ignored fields toward the cap, not just files", async () => {
    // A multipart body may carry arbitrary non-file parts; the aggregate limit
    // has to cover the whole body or field padding becomes the bypass.
    const app = buildUploadApp(1024);
    const body = chunkedMultipart([{ name: "ignored", value: "x".repeat(8 * 1024) }]);

    const response = await app.request(chunkedRequest("/api/inbox/upload", body));
    expect(response.status).toBe(413);
  });

  it("leaves an under-cap upload alone", async () => {
    const app = buildUploadApp(64 * 1024);
    const body = chunkedMultipart([
      { name: "file", filename: "small.epub", value: new Uint8Array(512) },
    ]);

    const response = await app.request(chunkedRequest("/api/inbox/upload", body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, parts: 1 });
  });

  it("still applies the 1 MB ceiling to non-upload bodies", async () => {
    const app = buildUploadApp();
    const response = await app.request("/api/other", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1_200_000),
    });
    expect(response.status).toBe(413);
  });

  it("keeps accepting ordinary non-upload bodies", async () => {
    const app = buildUploadApp();
    const response = await app.request("/api/other", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(response.status).toBe(200);
  });
});
