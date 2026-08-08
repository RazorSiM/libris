import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import {
  buildZip,
  CD_SIG,
  EOCD_SIG,
  findEocd,
  MAX_CENTRAL_DIRECTORY_BYTES,
  MAX_ZIP_ENTRIES,
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

// Every byte budget in this module is derived from
// `uncompressedSize`, so entries declaring size 0 are free. A 46-byte central
// directory record buys one ZipEntry object plus one open/read/close round
// trip, and nothing capped how many of them an archive could declare.
describe("ZIP central-directory entry-count cap", () => {
  /** A minimal, well-formed central directory record. */
  function cdRecord(name: string): Buffer {
    const nameBytes = Buffer.from(name, "utf8");
    const record = Buffer.alloc(46 + nameBytes.length);
    record.writeUInt32LE(CD_SIG, 0);
    record.writeUInt16LE(nameBytes.length, 28);
    nameBytes.copy(record, 46);
    return record;
  }

  /** An archive that is nothing but a central directory and an EOCD at offset 0. */
  function archiveOf(records: Buffer[], declaredCdSize?: number): Buffer {
    const directory = Buffer.concat(records);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(records.length & 0xffff, 8);
    eocd.writeUInt16LE(records.length & 0xffff, 10);
    eocd.writeUInt32LE(declaredCdSize ?? directory.length, 12);
    eocd.writeUInt32LE(0, 16);
    return Buffer.concat([directory, eocd]);
  }

  function repeatRecords(count: number): Buffer[] {
    return Array.from({ length: count }, (_, i) => cdRecord(`f${i % 10}`));
  }

  it("throws once the directory declares more than MAX_ZIP_ENTRIES records", () => {
    const directory = Buffer.concat(repeatRecords(MAX_ZIP_ENTRIES + 1));

    expect(() => parseCentralDirectory(directory, directory.length)).toThrow(ZipLimitError);
    expect(() => parseCentralDirectory(directory, directory.length)).toThrow(/more than/i);
  });

  it("still parses a directory sitting exactly on the cap", () => {
    const directory = Buffer.concat(repeatRecords(MAX_ZIP_ENTRIES));

    expect(parseCentralDirectory(directory, directory.length)).toHaveLength(MAX_ZIP_ENTRIES);
  });

  it("propagates the cap through readAllZipEntries, so every caller inherits it", async () => {
    const path = await writeZip("entry-flood.zip", archiveOf(repeatRecords(MAX_ZIP_ENTRIES + 1)));

    await expect(readAllZipEntries(path)).rejects.toThrow(ZipLimitError);
  });

  it("bounds the central-directory read before allocating it", async () => {
    // A tiny file whose EOCD claims a huge directory. The bound has to be
    // checked against the DECLARED size: reading first would either allocate
    // the claim or (here) quietly return a short buffer that parses fine.
    const path = await writeZip(
      "lying-cd-size.zip",
      archiveOf(repeatRecords(1), MAX_CENTRAL_DIRECTORY_BYTES + 1),
    );

    await expect(readAllZipEntries(path)).rejects.toThrow(/central directory exceeds/i);
  });

  it("does not let zero-length filenames inflate the entry list", () => {
    // 46 bytes each and no name is the cheapest possible padding record.
    const directory = Buffer.concat([
      cdRecord("mimetype"),
      ...Array.from({ length: MAX_ZIP_ENTRIES * 2 }, () => cdRecord("")),
    ]);

    const entries = parseCentralDirectory(directory, directory.length);

    expect(entries.map((e) => e.fileName)).toEqual(["mimetype"]);
  });

  it("still parses an archive with as many entries as a large real EPUB", async () => {
    const zip = buildZip([
      { name: "mimetype", data: Buffer.from("application/epub+zip") },
      ...Array.from({ length: 400 }, (_, i) => ({
        name: `OEBPS/p${i}.xhtml`,
        data: Buffer.from(`<html><body>page ${i}</body></html>`),
      })),
    ]);
    const path = await writeZip("large-real-epub.zip", zip);

    expect(centralEntries(zip)).toHaveLength(401);
    const { entries, rawEntries } = await readAllZipEntries(path);
    expect(entries).toHaveLength(401);
    expect(rawEntries.get("OEBPS/p399.xhtml")?.toString()).toContain("page 399");
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
