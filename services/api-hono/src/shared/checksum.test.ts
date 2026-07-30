import { createHash } from "node:crypto";
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { computeChecksumFromBuffer, computeChecksumFromFile } from "./checksum";

// ── Fixtures ────────────────────────────────────────────────────────

const SAMPLE_CONTENT = "Hello, Libris! This is a test file for checksum computation.";
const SAMPLE_BUFFER = Buffer.from(SAMPLE_CONTENT);
const EXPECTED_SHA256 = createHash("sha256").update(SAMPLE_BUFFER).digest("hex");

let tempDir: string;
let tempFilePath: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "libris-checksum-test-"));
  tempFilePath = join(tempDir, "test-file.epub");
  await writeFile(tempFilePath, SAMPLE_CONTENT);
});

afterAll(async () => {
  await unlink(tempFilePath).catch(() => {});
});

// ── computeChecksumFromBuffer ───────────────────────────────────────

describe("computeChecksumFromBuffer", () => {
  it("returns SHA-256 hex string for a Buffer", () => {
    const result = computeChecksumFromBuffer(SAMPLE_BUFFER);
    expect(result).toBe(EXPECTED_SHA256);
  });

  it("returns SHA-256 hex string for a Uint8Array", () => {
    const uint8 = new Uint8Array(SAMPLE_BUFFER);
    const result = computeChecksumFromBuffer(uint8);
    expect(result).toBe(EXPECTED_SHA256);
  });

  it("returns a 64-character hex string", () => {
    const result = computeChecksumFromBuffer(SAMPLE_BUFFER);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different checksums for different content", () => {
    const a = computeChecksumFromBuffer(Buffer.from("content-a"));
    const b = computeChecksumFromBuffer(Buffer.from("content-b"));
    expect(a).not.toBe(b);
  });

  it("produces identical checksums for identical content", () => {
    const a = computeChecksumFromBuffer(Buffer.from("same-content"));
    const b = computeChecksumFromBuffer(Buffer.from("same-content"));
    expect(a).toBe(b);
  });

  it("handles empty buffer", () => {
    const result = computeChecksumFromBuffer(Buffer.alloc(0));
    const expected = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
    expect(result).toBe(expected);
  });
});

// ── computeChecksumFromFile ─────────────────────────────────────────

describe("computeChecksumFromFile", () => {
  it("returns SHA-256 matching the known content hash", async () => {
    const result = await computeChecksumFromFile(tempFilePath);
    expect(result).toBe(EXPECTED_SHA256);
  });

  it("returns a 64-character hex string", async () => {
    const result = await computeChecksumFromFile(tempFilePath);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
  });

  it("matches computeChecksumFromBuffer for the same content", async () => {
    const fromFile = await computeChecksumFromFile(tempFilePath);
    const fromBuffer = computeChecksumFromBuffer(SAMPLE_BUFFER);
    expect(fromFile).toBe(fromBuffer);
  });

  it("rejects for non-existent file", async () => {
    await expect(computeChecksumFromFile("/tmp/nonexistent-file-xyz.epub")).rejects.toThrow();
  });
});
