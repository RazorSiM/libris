import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  buildZip,
  findEocd,
  parseCentralDirectory,
  readAllZipEntries,
  readZipEntry,
  ZipLimitError,
} from "./zip.js";

let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "libris-zip-limits-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

async function writeZip(name: string, data: Buffer): Promise<string> {
  const path = join(tempDir, name);
  await writeFile(path, data);
  return path;
}

function centralEntries(zip: Buffer) {
  const eocd = findEocd(zip);
  const size = zip.readUInt32LE(eocd + 12);
  const offset = zip.readUInt32LE(eocd + 16);
  return parseCentralDirectory(zip.subarray(offset, offset + size), size);
}

describe("ZIP decompression budgets", () => {
  it("rejects an honestly declared oversized entry before inflating", async () => {
    const zip = buildZip([{ name: "large.bin", data: Buffer.alloc(256), compress: true }]);
    const path = await writeZip("honest-limit.zip", zip);
    const [entry] = centralEntries(zip);

    await expect(readZipEntry(path, entry!, { maxOutputBytes: 100 })).rejects.toThrow(
      ZipLimitError,
    );
  });

  it("rejects output beyond the cap when the central directory lies", async () => {
    const zip = buildZip([{ name: "liar.bin", data: Buffer.alloc(4096), compress: true }]);
    const eocd = findEocd(zip);
    const cdOffset = zip.readUInt32LE(eocd + 16);
    zip.writeUInt32LE(1, cdOffset + 24);
    const path = await writeZip("lying-limit.zip", zip);
    const [entry] = centralEntries(zip);

    await expect(readZipEntry(path, entry!, { maxOutputBytes: 100 })).rejects.toThrow(
      ZipLimitError,
    );
  });

  it("rejects many individually safe entries that exceed the archive budget", async () => {
    const zip = buildZip([
      { name: "one", data: Buffer.alloc(90), compress: true },
      { name: "two", data: Buffer.alloc(90), compress: true },
      { name: "three", data: Buffer.alloc(90), compress: true },
    ]);
    const path = await writeZip("archive-limit.zip", zip);

    await expect(
      readAllZipEntries(path, { maxEntryBytes: 100, maxTotalBytes: 250 }),
    ).rejects.toThrow(/archive.*budget/i);
  });
});

describe("ZIP compression preservation", () => {
  it("compresses non-mimetype entries by default and keeps mimetype first and stored", () => {
    const zip = buildZip([
      { name: "mimetype", data: Buffer.from("application/epub+zip") },
      { name: "chapter.xhtml", data: Buffer.alloc(4096, "a") },
    ]);
    const entries = centralEntries(zip);

    expect(entries.map(({ fileName, compression }) => ({ fileName, compression }))).toEqual([
      { fileName: "mimetype", compression: 0 },
      { fileName: "chapter.xhtml", compression: 8 },
    ]);
    expect(zip.length).toBeLessThan(1000);
  });
});
