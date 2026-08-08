import { describe, expect, it } from "vite-plus/test";
import { MAX_CENTRAL_DIRECTORY_BYTES, MAX_ZIP_ENTRIES } from "../lib/epub/zip.js";
import { validateEpubUpload } from "./epub-validation.js";

function epubPrefix(mimetype = "application/epub+zip", firstName = "mimetype"): Buffer {
  const name = Buffer.from(firstName);
  const body = Buffer.from(mimetype);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(0, 8);
  header.writeUInt32LE(body.length, 18);
  header.writeUInt32LE(body.length, 22);
  header.writeUInt16LE(name.length, 26);
  const local = Buffer.concat([header, name, body]);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);
  const directory = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, directory, eocd]);
}

describe("validateEpubUpload", () => {
  it("accepts the required first mimetype entry", () => {
    expect(validateEpubUpload(epubPrefix())).toBeNull();
  });

  it.each([
    [Buffer.alloc(0), /empty/i],
    [Buffer.from("not a zip"), /ZIP archive/i],
    [epubPrefix("application/epub+zip", "content.opf"), /first entry/i],
    [epubPrefix("application/zip"), /application\/epub\+zip/i],
  ])("rejects malformed EPUB content", (input, error) => {
    expect(validateEpubUpload(input)).toMatch(error);
  });

  // An entry flood used to sail through here and only blow up in
  // the ingestion worker, where it is an in-process outage instead of a 400.
  describe("central-directory entry flood", () => {
    /**
     * A structurally valid EPUB upload whose central directory holds a real
     * "mimetype" record followed by `fillerCount` padding records. Everything
     * stays self-consistent, so the pre-existing structural checks all pass and
     * only the new limit can reject it.
     */
    function epubWithDirectory(fillerCount: number, fillerNameLength: number): Buffer {
      const name = Buffer.from("mimetype");
      const body = Buffer.from("application/epub+zip");
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt32LE(body.length, 18);
      header.writeUInt32LE(body.length, 22);
      header.writeUInt16LE(name.length, 26);
      const local = Buffer.concat([header, name, body]);

      const first = Buffer.alloc(46 + name.length);
      first.writeUInt32LE(0x02014b50, 0);
      first.writeUInt32LE(body.length, 20);
      first.writeUInt32LE(body.length, 24);
      first.writeUInt16LE(name.length, 28);
      first.writeUInt32LE(0, 42);
      name.copy(first, 46);

      const fillerName = Buffer.alloc(fillerNameLength, 0x61);
      const filler = Buffer.alloc(46 + fillerNameLength);
      filler.writeUInt32LE(0x02014b50, 0);
      filler.writeUInt16LE(fillerNameLength, 28);
      fillerName.copy(filler, 46);

      const directory = Buffer.concat([
        first,
        ...Array.from({ length: fillerCount }, () => filler),
      ]);
      const eocd = Buffer.alloc(22);
      eocd.writeUInt32LE(0x06054b50, 0);
      eocd.writeUInt16LE((fillerCount + 1) & 0xffff, 8);
      eocd.writeUInt16LE((fillerCount + 1) & 0xffff, 10);
      eocd.writeUInt32LE(directory.length, 12);
      eocd.writeUInt32LE(local.length, 16);
      return Buffer.concat([local, directory, eocd]);
    }

    it("rejects a directory declaring more records than the parser will ever build", () => {
      // ~470 KB on the wire buys 10,001 ZipEntry objects during ingestion.
      expect(validateEpubUpload(epubWithDirectory(MAX_ZIP_ENTRIES, 1))).toMatch(
        /too many entries/i,
      );
    });

    it("rejects an oversized directory even when the record count is small", () => {
      const buffer = epubWithDirectory(200, 21_000);
      const directorySize = buffer.readUInt32LE(buffer.length - 22 + 12);
      expect(directorySize).toBeGreaterThan(MAX_CENTRAL_DIRECTORY_BYTES);
      expect(buffer.readUInt16LE(buffer.length - 22 + 10)).toBeLessThan(MAX_ZIP_ENTRIES);

      expect(validateEpubUpload(buffer)).toMatch(/too many entries/i);
    });

    it("still accepts a directory sized for a large real EPUB", () => {
      expect(validateEpubUpload(epubWithDirectory(999, 40))).toBeNull();
    });
  });
});
