import { describe, expect, it } from "vite-plus/test";
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
});
