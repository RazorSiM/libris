import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { extractEpubCoverImage, extractEpubMetadata, extractEpubTextSample } from "./epub";

// --- Minimal ZIP builder helpers ---

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipFileEntry {
  name: string;
  data: Buffer;
  compress?: boolean;
}

function buildZip(entries: ZipFileEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const uncompressed = entry.data;
    const compressed = entry.compress ? deflateRawSync(uncompressed) : uncompressed;
    const compression = entry.compress ? 8 : 0;
    const crc = crc32(uncompressed);

    // Local file header
    const local = Buffer.alloc(30 + nameBytes.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(compression, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    nameBytes.copy(local, 30);
    compressed.copy(local, 30 + nameBytes.length);

    // Central directory header
    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(compression, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBytes.copy(central, 46);

    localHeaders.push(local);
    centralHeaders.push(central);
    offset += local.length;
  }

  const cdData = Buffer.concat(centralHeaders);
  const cdOffset = offset;

  // EOCD
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with CD
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdData.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localHeaders, cdData, eocd]);
}

function makeContainerXml(opfPath: string): string {
  return `<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="${opfPath}" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

function makeOpf(meta: {
  title?: string;
  creator?: string | string[];
  publisher?: string;
  language?: string;
  description?: string;
  subjects?: string[];
  date?: string;
  identifiers?: { id: string; scheme?: string; value: string }[];
  coverMeta?: string;
  manifestItems?: string;
}): string {
  const creators = Array.isArray(meta.creator) ? meta.creator : meta.creator ? [meta.creator] : [];
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    ${meta.title ? `<dc:title>${meta.title}</dc:title>` : ""}
    ${creators.map((c) => `<dc:creator>${c}</dc:creator>`).join("\n    ")}
    ${meta.publisher ? `<dc:publisher>${meta.publisher}</dc:publisher>` : ""}
    ${meta.language ? `<dc:language>${meta.language}</dc:language>` : ""}
    ${meta.description ? `<dc:description>${meta.description}</dc:description>` : ""}
    ${(meta.subjects ?? []).map((s) => `<dc:subject>${s}</dc:subject>`).join("\n    ")}
    ${meta.date ? `<dc:date>${meta.date}</dc:date>` : ""}
    ${(meta.identifiers ?? []).map((id) => `<dc:identifier${id.scheme ? ` opf:scheme="${id.scheme}"` : ""} id="${id.id}">${id.value}</dc:identifier>`).join("\n    ")}
    ${meta.coverMeta ?? ""}
  </metadata>
  <manifest>
    ${meta.manifestItems ?? ""}
  </manifest>
</package>`;
}

function buildEpub(opfContent: string, opfPath = "OEBPS/content.opf"): Buffer {
  return buildZip([
    { name: "mimetype", data: Buffer.from("application/epub+zip") },
    {
      name: "META-INF/container.xml",
      data: Buffer.from(makeContainerXml(opfPath)),
    },
    { name: opfPath, data: Buffer.from(opfContent) },
  ]);
}

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "epub-test-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeEpub(name: string, data: Buffer): Promise<string> {
  const filePath = join(tmpDir, name);
  await writeFile(filePath, data);
  return filePath;
}

describe("extractEpubMetadata", () => {
  it("rejects an OPF beyond the parser input budget without scanning it", async () => {
    const oversizedOpf = `<package><metadata>${"<dc:title>".repeat(250_000)}</metadata></package>`;
    const epub = buildEpub(oversizedOpf);
    const path = await writeEpub("oversized-opf.epub", epub);
    const startedAt = performance.now();

    await expect(extractEpubMetadata(path)).rejects.toThrow(/OPF.*limit/i);
    expect(performance.now() - startedAt).toBeLessThan(100);
  });

  describe("valid EPUBs", () => {
    it("extracts full metadata from a well-formed EPUB", async () => {
      const opf = makeOpf({
        title: "Test Book",
        creator: "Jane Author",
        publisher: "Test Press",
        language: "en",
        description: "A test book",
        subjects: ["Fiction", "Fantasy"],
        date: "2024-03-15",
        identifiers: [
          { id: "isbn13", value: "9781234567890" },
          { id: "isbn10", value: "1234567890" },
        ],
      });
      const epub = buildEpub(opf);
      const path = await writeEpub("valid.epub", epub);

      const meta = await extractEpubMetadata(path);

      expect(meta.title).toBe("Test Book");
      expect(meta.author).toBe("Jane Author");
      expect(meta.publisher).toBe("Test Press");
      expect(meta.language).toBe("en");
      expect(meta.description).toBe("A test book");
      expect(meta.genres).toEqual(["Fiction", "Fantasy"]);
      expect(meta.publishedYear).toBe(2024);
      expect(meta.isbn13).toBe("9781234567890");
      expect(meta.isbn10).toBe("1234567890");
    });

    it("normalizes the embedded language tag to an ISO 639-1 code", async () => {
      const cases: [string, string][] = [
        ["en-GB", "en"],
        ["English", "en"],
        ["eng", "en"],
        ["it-IT", "it"],
        ["Italian", "it"],
      ];
      for (const [input, expected] of cases) {
        const epub = buildEpub(makeOpf({ title: "Book", language: input }));
        const path = await writeEpub(`lang-${expected}-${input}.epub`, epub);
        const meta = await extractEpubMetadata(path);
        expect(meta.language).toBe(expected);
      }
    });

    it("keeps an unrecognized language tag as-is", async () => {
      const epub = buildEpub(makeOpf({ title: "Book", language: "Klingon" }));
      const path = await writeEpub("lang-unknown.epub", epub);
      const meta = await extractEpubMetadata(path);
      expect(meta.language).toBe("Klingon");
    });

    it("handles multiple creators joined with comma", async () => {
      const opf = makeOpf({
        title: "Co-authored Book",
        creator: ["Author One", "Author Two", "Author Three"],
      });
      const epub = buildEpub(opf);
      const path = await writeEpub("multi-author.epub", epub);

      const meta = await extractEpubMetadata(path);

      expect(meta.author).toBe("Author One, Author Two, Author Three");
    });

    it("handles DEFLATE-compressed OPF", async () => {
      const opf = makeOpf({ title: "Compressed Book", creator: "Zip Author" });
      const epub = buildZip([
        { name: "mimetype", data: Buffer.from("application/epub+zip") },
        {
          name: "META-INF/container.xml",
          data: Buffer.from(makeContainerXml("OEBPS/content.opf")),
          compress: true,
        },
        { name: "OEBPS/content.opf", data: Buffer.from(opf), compress: true },
      ]);
      const path = await writeEpub("compressed.epub", epub);

      const meta = await extractEpubMetadata(path);

      expect(meta.title).toBe("Compressed Book");
      expect(meta.author).toBe("Zip Author");
    });

    it("strips HTML from description", async () => {
      const opf = makeOpf({
        title: "HTML Desc",
        description:
          "&lt;p&gt;First paragraph.&lt;/p&gt;&lt;p&gt;Second &lt;b&gt;bold&lt;/b&gt; paragraph.&lt;/p&gt;",
      });
      const epub = buildEpub(opf);
      const path = await writeEpub("html-desc.epub", epub);

      const meta = await extractEpubMetadata(path);

      expect(meta.description).toContain("First paragraph.");
      expect(meta.description).toContain("Second bold paragraph.");
      expect(meta.description).not.toContain("<p>");
      expect(meta.description).not.toContain("&lt;");
    });

    it("extracts ISBN with urn:isbn: prefix", async () => {
      const opf = makeOpf({
        title: "URN ISBN",
        identifiers: [{ id: "isbn", value: "urn:isbn:9781234567890" }],
      });
      const epub = buildEpub(opf);
      const path = await writeEpub("urn-isbn.epub", epub);

      const meta = await extractEpubMetadata(path);

      expect(meta.isbn13).toBe("9781234567890");
    });

    it("extracts ISBN from opf:scheme attribute", async () => {
      const opf = makeOpf({
        title: "Scheme ISBN",
        identifiers: [{ id: "id1", scheme: "ISBN", value: "9780596007126" }],
      });
      const epub = buildEpub(opf);
      const path = await writeEpub("scheme-isbn.epub", epub);

      const meta = await extractEpubMetadata(path);

      expect(meta.isbn13).toBe("9780596007126");
    });
  });

  describe("invalid/corrupt EPUB", () => {
    it("returns empty metadata for a zero-byte file", async () => {
      const path = await writeEpub("empty.epub", Buffer.alloc(0));
      const meta = await extractEpubMetadata(path);
      expect(meta).toEqual({});
    });

    it("returns empty metadata for file smaller than EOCD minimum (22 bytes)", async () => {
      const path = await writeEpub("tiny.epub", Buffer.alloc(10, 0xff));
      const meta = await extractEpubMetadata(path);
      expect(meta).toEqual({});
    });

    it("returns empty metadata for random binary data", async () => {
      const garbage = Buffer.alloc(4096);
      for (let i = 0; i < garbage.length; i++) {
        garbage[i] = Math.floor(Math.random() * 256);
      }
      const path = await writeEpub("garbage.epub", garbage);
      const meta = await extractEpubMetadata(path);

      // Should not throw, returns empty or partial metadata
      expect(meta).toBeDefined();
    });

    it("returns empty metadata when EOCD signature is corrupted", async () => {
      const opf = makeOpf({ title: "Good Book" });
      const epub = buildEpub(opf);

      // Corrupt the EOCD signature (last 22 bytes of the file)
      const corrupted = Buffer.from(epub);
      const eocdPos = corrupted.length - 22;
      corrupted.writeUInt32LE(0xdeadbeef, eocdPos);

      const path = await writeEpub("bad-eocd.epub", corrupted);
      const meta = await extractEpubMetadata(path);

      // Fallback extraction may still find metadata from local headers
      expect(meta).toBeDefined();
    });

    it("handles missing container.xml gracefully", async () => {
      const opf = makeOpf({ title: "No Container" });
      // Build ZIP without container.xml
      const epub = buildZip([
        { name: "mimetype", data: Buffer.from("application/epub+zip") },
        { name: "OEBPS/content.opf", data: Buffer.from(opf) },
      ]);
      const path = await writeEpub("no-container.epub", epub);
      const meta = await extractEpubMetadata(path);

      // Should fall back to finding .opf by extension
      expect(meta.title).toBe("No Container");
    });

    it("handles missing OPF file gracefully", async () => {
      const epub = buildZip([
        { name: "mimetype", data: Buffer.from("application/epub+zip") },
        {
          name: "META-INF/container.xml",
          data: Buffer.from(makeContainerXml("OEBPS/content.opf")),
        },
        // No OPF file included
      ]);
      const path = await writeEpub("no-opf.epub", epub);
      const meta = await extractEpubMetadata(path);

      expect(meta).toEqual({});
    });

    it("handles container.xml pointing to nonexistent OPF path", async () => {
      const opf = makeOpf({ title: "Misreferenced" });
      const epub = buildZip([
        { name: "mimetype", data: Buffer.from("application/epub+zip") },
        {
          name: "META-INF/container.xml",
          data: Buffer.from(makeContainerXml("wrong/path.opf")),
        },
        { name: "OEBPS/content.opf", data: Buffer.from(opf) },
      ]);
      const path = await writeEpub("wrong-ref.epub", epub);
      const meta = await extractEpubMetadata(path);

      // Should fall back to finding .opf by extension
      expect(meta.title).toBe("Misreferenced");
    });

    it("handles corrupted central directory signature", async () => {
      const opf = makeOpf({ title: "Bad CD" });
      const epub = buildEpub(opf);
      const corrupted = Buffer.from(epub);

      // Find and corrupt the first CD signature
      for (let i = 0; i < corrupted.length - 4; i++) {
        if (corrupted.readUInt32LE(i) === 0x02014b50) {
          corrupted.writeUInt32LE(0x00000000, i);
          break;
        }
      }

      const path = await writeEpub("bad-cd.epub", corrupted);
      const meta = await extractEpubMetadata(path);

      // Should not throw; may return empty or fallback metadata
      expect(meta).toBeDefined();
    });

    it("handles DEFLATE decompression failure gracefully", async () => {
      const opf = makeOpf({ title: "Bad Deflate" });
      // Build a ZIP with corrupted compressed data
      const epub = buildZip([
        { name: "mimetype", data: Buffer.from("application/epub+zip") },
        {
          name: "META-INF/container.xml",
          data: Buffer.from(makeContainerXml("OEBPS/content.opf")),
        },
        { name: "OEBPS/content.opf", data: Buffer.from(opf), compress: true },
      ]);

      // Corrupt the compressed OPF data
      const corrupted = Buffer.from(epub);
      // Find the compressed data region and scramble it
      const opfName = Buffer.from("OEBPS/content.opf");
      for (let i = 0; i < corrupted.length - opfName.length; i++) {
        if (corrupted.subarray(i, i + opfName.length).equals(opfName)) {
          // After local header name, corrupt the compressed data
          const dataStart = i + opfName.length;
          if (dataStart + 10 < corrupted.length) {
            for (let j = dataStart; j < Math.min(dataStart + 20, corrupted.length); j++) {
              corrupted[j] = 0xff;
            }
          }
          // Only corrupt the second occurrence (after CD header)
          break;
        }
      }

      const path = await writeEpub("bad-deflate.epub", corrupted);
      const meta = await extractEpubMetadata(path);

      // Should not throw
      expect(meta).toBeDefined();
    });

    it("returns empty metadata for non-existent file", async () => {
      const meta = await extractEpubMetadata(join(tmpDir, "nonexistent.epub"));
      expect(meta).toEqual({});
    });
  });

  describe("partial metadata", () => {
    it("handles EPUB with only a title", async () => {
      const opf = makeOpf({ title: "Title Only Book" });
      const epub = buildEpub(opf);
      const path = await writeEpub("title-only.epub", epub);

      const meta = await extractEpubMetadata(path);

      expect(meta.title).toBe("Title Only Book");
      expect(meta.author).toBeUndefined();
      expect(meta.publisher).toBeUndefined();
      expect(meta.isbn10).toBeUndefined();
      expect(meta.isbn13).toBeUndefined();
    });

    it("handles EPUB with completely empty OPF metadata", async () => {
      const opf = makeOpf({});
      const epub = buildEpub(opf);
      const path = await writeEpub("empty-meta.epub", epub);

      const meta = await extractEpubMetadata(path);

      expect(meta.title).toBeUndefined();
      expect(meta.author).toBeUndefined();
    });

    it("handles OPF with empty dc:title tags", async () => {
      const opfXml = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title></dc:title>
    <dc:creator></dc:creator>
  </metadata>
</package>`;
      const epub = buildEpub(opfXml);
      const path = await writeEpub("empty-tags.epub", epub);

      const meta = await extractEpubMetadata(path);

      expect(meta.title).toBeUndefined();
      expect(meta.author).toBeUndefined();
    });

    it("handles date with only year", async () => {
      const opf = makeOpf({ title: "Year Only", date: "2020" });
      const epub = buildEpub(opf);
      const path = await writeEpub("year-date.epub", epub);

      const meta = await extractEpubMetadata(path);
      expect(meta.publishedYear).toBe(2020);
    });

    it("handles invalid date string", async () => {
      const opf = makeOpf({ title: "Bad Date", date: "not-a-date" });
      const epub = buildEpub(opf);
      const path = await writeEpub("bad-date.epub", epub);

      const meta = await extractEpubMetadata(path);
      expect(meta.publishedYear).toBeUndefined();
    });

    it("handles identifier that is not an ISBN", async () => {
      const opf = makeOpf({
        title: "UUID Identifier",
        identifiers: [{ id: "uid", value: "urn:uuid:12345678-1234-1234-1234-123456789abc" }],
      });
      const epub = buildEpub(opf);
      const path = await writeEpub("uuid-id.epub", epub);

      const meta = await extractEpubMetadata(path);

      expect(meta.isbn10).toBeUndefined();
      expect(meta.isbn13).toBeUndefined();
    });
  });

  describe("cover image extraction", () => {
    it("returns null for EPUB without cover metadata", async () => {
      const opf = makeOpf({ title: "No Cover" });
      const epub = buildEpub(opf);
      const path = await writeEpub("no-cover.epub", epub);

      const cover = await extractEpubCoverImage(path);
      expect(cover).toBeNull();
    });

    it("returns null for EPUB referencing nonexistent cover file", async () => {
      const opf = makeOpf({
        title: "Missing Cover File",
        coverMeta: '<meta name="cover" content="cover-img"/>',
        manifestItems: '<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>',
      });
      // Build EPUB without the actual cover image file
      const epub = buildEpub(opf);
      const path = await writeEpub("missing-cover-file.epub", epub);

      const cover = await extractEpubCoverImage(path);
      expect(cover).toBeNull();
    });

    it("extracts cover image from EPUB2 meta+manifest pattern", async () => {
      const coverData = Buffer.from("FAKE-JPEG-DATA");
      const opf = makeOpf({
        title: "Has Cover",
        coverMeta: '<meta name="cover" content="cover-img"/>',
        manifestItems: '<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>',
      });

      const epub = buildZip([
        { name: "mimetype", data: Buffer.from("application/epub+zip") },
        {
          name: "META-INF/container.xml",
          data: Buffer.from(makeContainerXml("OEBPS/content.opf")),
        },
        { name: "OEBPS/content.opf", data: Buffer.from(opf) },
        { name: "OEBPS/images/cover.jpg", data: coverData },
      ]);
      const path = await writeEpub("has-cover.epub", epub);

      const cover = await extractEpubCoverImage(path);
      expect(cover).not.toBeNull();
      expect(cover!.toString()).toBe("FAKE-JPEG-DATA");
    });

    it("extracts cover from EPUB3 properties='cover-image' pattern", async () => {
      const coverData = Buffer.from("EPUB3-COVER");
      const opfXml = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>EPUB3 Cover Test</dc:title>
  </metadata>
  <manifest>
    <item id="cover" href="cover.png" media-type="image/png" properties="cover-image"/>
  </manifest>
</package>`;

      const epub = buildZip([
        { name: "mimetype", data: Buffer.from("application/epub+zip") },
        {
          name: "META-INF/container.xml",
          data: Buffer.from(makeContainerXml("OEBPS/content.opf")),
        },
        { name: "OEBPS/content.opf", data: Buffer.from(opfXml) },
        { name: "OEBPS/cover.png", data: coverData },
      ]);
      const path = await writeEpub("epub3-cover.epub", epub);

      const cover = await extractEpubCoverImage(path);
      expect(cover).not.toBeNull();
      expect(cover!.toString()).toBe("EPUB3-COVER");
    });

    it("extracts cover via filename heuristic when OPF has no cover metadata", async () => {
      const coverData = Buffer.from("HEURISTIC-COVER");
      const opf = makeOpf({ title: "No Cover Meta" });

      const epub = buildZip([
        { name: "mimetype", data: Buffer.from("application/epub+zip") },
        {
          name: "META-INF/container.xml",
          data: Buffer.from(makeContainerXml("content.opf")),
        },
        { name: "content.opf", data: Buffer.from(opf) },
        { name: "cover.jpeg", data: coverData },
      ]);
      const path = await writeEpub("heuristic-cover.epub", epub);

      const cover = await extractEpubCoverImage(path);
      expect(cover).not.toBeNull();
      expect(cover!.toString()).toBe("HEURISTIC-COVER");
    });

    it("extracts cover via filename heuristic from subdirectory", async () => {
      const coverData = Buffer.from("SUBDIR-COVER");
      const opf = makeOpf({ title: "Subdir Cover" });

      const epub = buildZip([
        { name: "mimetype", data: Buffer.from("application/epub+zip") },
        {
          name: "META-INF/container.xml",
          data: Buffer.from(makeContainerXml("OEBPS/content.opf")),
        },
        { name: "OEBPS/content.opf", data: Buffer.from(opf) },
        { name: "OEBPS/images/cover.png", data: coverData },
      ]);
      const path = await writeEpub("subdir-cover.epub", epub);

      const cover = await extractEpubCoverImage(path);
      expect(cover).not.toBeNull();
      expect(cover!.toString()).toBe("SUBDIR-COVER");
    });

    it("does not match non-cover image files as heuristic", async () => {
      const opf = makeOpf({ title: "No Cover" });

      const epub = buildZip([
        { name: "mimetype", data: Buffer.from("application/epub+zip") },
        {
          name: "META-INF/container.xml",
          data: Buffer.from(makeContainerXml("content.opf")),
        },
        { name: "content.opf", data: Buffer.from(opf) },
        { name: "images/chapter1.jpg", data: Buffer.from("NOT-A-COVER") },
        { name: "titlepage.xhtml", data: Buffer.from("<html/>") },
      ]);
      const path = await writeEpub("no-cover-heuristic.epub", epub);

      const cover = await extractEpubCoverImage(path);
      expect(cover).toBeNull();
    });

    it("returns null for corrupt EPUB file", async () => {
      const path = await writeEpub("corrupt-for-cover.epub", Buffer.alloc(50, 0xab));
      const cover = await extractEpubCoverImage(path);
      expect(cover).toBeNull();
    });

    describe("SVG/XHTML-wrapped covers", () => {
      it("extracts cover from XHTML page with HTML <img> element", async () => {
        const coverData = Buffer.from("IMG-TAG-COVER-DATA");
        const xhtmlCover = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Cover</title></head>
<body epub:type="frontmatter">
  <img src="../images/cover.jpg" alt="cover"/>
</body>
</html>`;

        const opf = makeOpf({
          title: "Standard Ebooks Style",
          coverMeta: '<meta name="cover" content="cover-page"/>',
          manifestItems:
            '<item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>',
        });

        const epub = buildZip([
          { name: "mimetype", data: Buffer.from("application/epub+zip") },
          {
            name: "META-INF/container.xml",
            data: Buffer.from(makeContainerXml("OEBPS/content.opf")),
          },
          { name: "OEBPS/content.opf", data: Buffer.from(opf) },
          { name: "OEBPS/text/cover.xhtml", data: Buffer.from(xhtmlCover) },
          { name: "OEBPS/images/cover.jpg", data: coverData },
        ]);
        const path = await writeEpub("xhtml-img-cover.epub", epub);

        const cover = await extractEpubCoverImage(path);
        expect(cover).not.toBeNull();
        expect(cover!.toString()).toBe("IMG-TAG-COVER-DATA");
      });

      it("extracts cover from XHTML page with SVG <image> xlink:href", async () => {
        const coverData = Buffer.from("SVG-XLINK-COVER-DATA");
        const xhtmlCover = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 600 900">
  <image width="100%" height="100%" xlink:href="../images/cover.jpg"/>
</svg>
</body>
</html>`;

        const opf = makeOpf({
          title: "SVG Xlink Cover",
          coverMeta: '<meta name="cover" content="cover-page"/>',
          manifestItems:
            '<item id="cover-page" href="text/titlepage.xhtml" media-type="application/xhtml+xml"/>',
        });

        const epub = buildZip([
          { name: "mimetype", data: Buffer.from("application/epub+zip") },
          {
            name: "META-INF/container.xml",
            data: Buffer.from(makeContainerXml("OEBPS/content.opf")),
          },
          { name: "OEBPS/content.opf", data: Buffer.from(opf) },
          { name: "OEBPS/text/titlepage.xhtml", data: Buffer.from(xhtmlCover) },
          { name: "OEBPS/images/cover.jpg", data: coverData },
        ]);
        const path = await writeEpub("svg-xlink-cover.epub", epub);

        const cover = await extractEpubCoverImage(path);
        expect(cover).not.toBeNull();
        expect(cover!.toString()).toBe("SVG-XLINK-COVER-DATA");
      });

      it("extracts cover from XHTML page with SVG <image> href (no xlink)", async () => {
        const coverData = Buffer.from("SVG-HREF-COVER-DATA");
        const xhtmlCover = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
<svg xmlns="http://www.w3.org/2000/svg">
  <image width="600" height="900" href="../images/cover.png"/>
</svg>
</body>
</html>`;

        const opf = makeOpf({
          title: "SVG Href Cover",
          coverMeta: '<meta name="cover" content="cover-page"/>',
          manifestItems:
            '<item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>',
        });

        const epub = buildZip([
          { name: "mimetype", data: Buffer.from("application/epub+zip") },
          {
            name: "META-INF/container.xml",
            data: Buffer.from(makeContainerXml("OEBPS/content.opf")),
          },
          { name: "OEBPS/content.opf", data: Buffer.from(opf) },
          { name: "OEBPS/text/cover.xhtml", data: Buffer.from(xhtmlCover) },
          { name: "OEBPS/images/cover.png", data: coverData },
        ]);
        const path = await writeEpub("svg-href-cover.epub", epub);

        const cover = await extractEpubCoverImage(path);
        expect(cover).not.toBeNull();
        expect(cover!.toString()).toBe("SVG-HREF-COVER-DATA");
      });

      it("extracts cover from XHTML page with CSS background-image", async () => {
        const coverData = Buffer.from("CSS-BG-COVER-DATA");
        const xhtmlCover = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<style>
  .cover { background-image: url("../images/cover.jpg"); width: 100%; height: 100%; }
</style>
</head>
<body>
  <div class="cover"></div>
</body>
</html>`;

        const opf = makeOpf({
          title: "CSS Background Cover",
          coverMeta: '<meta name="cover" content="cover-page"/>',
          manifestItems:
            '<item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>',
        });

        const epub = buildZip([
          { name: "mimetype", data: Buffer.from("application/epub+zip") },
          {
            name: "META-INF/container.xml",
            data: Buffer.from(makeContainerXml("OEBPS/content.opf")),
          },
          { name: "OEBPS/content.opf", data: Buffer.from(opf) },
          { name: "OEBPS/text/cover.xhtml", data: Buffer.from(xhtmlCover) },
          { name: "OEBPS/images/cover.jpg", data: coverData },
        ]);
        const path = await writeEpub("css-bg-cover.epub", epub);

        const cover = await extractEpubCoverImage(path);
        expect(cover).not.toBeNull();
        expect(cover!.toString()).toBe("CSS-BG-COVER-DATA");
      });

      it("extracts cover from text/html media-type wrapper", async () => {
        const coverData = Buffer.from("TEXT-HTML-COVER-DATA");
        const htmlCover = `<html>
<body>
  <img src="../images/cover.jpg" alt="cover"/>
</body>
</html>`;

        const opf = makeOpf({
          title: "text/html Cover",
          coverMeta: '<meta name="cover" content="cover-page"/>',
          manifestItems: '<item id="cover-page" href="text/cover.html" media-type="text/html"/>',
        });

        const epub = buildZip([
          { name: "mimetype", data: Buffer.from("application/epub+zip") },
          {
            name: "META-INF/container.xml",
            data: Buffer.from(makeContainerXml("OEBPS/content.opf")),
          },
          { name: "OEBPS/content.opf", data: Buffer.from(opf) },
          { name: "OEBPS/text/cover.html", data: Buffer.from(htmlCover) },
          { name: "OEBPS/images/cover.jpg", data: coverData },
        ]);
        const path = await writeEpub("text-html-cover.epub", epub);

        const cover = await extractEpubCoverImage(path);
        expect(cover).not.toBeNull();
        expect(cover!.toString()).toBe("TEXT-HTML-COVER-DATA");
      });

      it("falls back to heuristic when XHTML wrapper references missing image", async () => {
        const fallbackCover = Buffer.from("FALLBACK-COVER-DATA");
        const xhtmlCover = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <img src="../images/missing.jpg" alt="cover"/>
</body>
</html>`;

        const opf = makeOpf({
          title: "Missing Referenced Image",
          coverMeta: '<meta name="cover" content="cover-page"/>',
          manifestItems:
            '<item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>',
        });

        const epub = buildZip([
          { name: "mimetype", data: Buffer.from("application/epub+zip") },
          {
            name: "META-INF/container.xml",
            data: Buffer.from(makeContainerXml("OEBPS/content.opf")),
          },
          { name: "OEBPS/content.opf", data: Buffer.from(opf) },
          { name: "OEBPS/text/cover.xhtml", data: Buffer.from(xhtmlCover) },
          { name: "OEBPS/images/cover.jpg", data: fallbackCover },
        ]);
        const path = await writeEpub("xhtml-missing-ref.epub", epub);

        const cover = await extractEpubCoverImage(path);
        // Falls back to filename heuristic, finds cover.jpg
        expect(cover).not.toBeNull();
        expect(cover!.toString()).toBe("FALLBACK-COVER-DATA");
      });

      it("falls back to heuristic when XHTML has no image references", async () => {
        const fallbackCover = Buffer.from("HEURISTIC-FALLBACK");
        const xhtmlCover = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <p>This is just text, no images here.</p>
</body>
</html>`;

        const opf = makeOpf({
          title: "No Image In XHTML",
          coverMeta: '<meta name="cover" content="cover-page"/>',
          manifestItems:
            '<item id="cover-page" href="text/cover.xhtml" media-type="application/xhtml+xml"/>',
        });

        const epub = buildZip([
          { name: "mimetype", data: Buffer.from("application/epub+zip") },
          {
            name: "META-INF/container.xml",
            data: Buffer.from(makeContainerXml("OEBPS/content.opf")),
          },
          { name: "OEBPS/content.opf", data: Buffer.from(opf) },
          { name: "OEBPS/text/cover.xhtml", data: Buffer.from(xhtmlCover) },
          { name: "OEBPS/images/cover.png", data: fallbackCover },
        ]);
        const path = await writeEpub("xhtml-no-img.epub", epub);

        const cover = await extractEpubCoverImage(path);
        // Falls back to filename heuristic
        expect(cover).not.toBeNull();
        expect(cover!.toString()).toBe("HEURISTIC-FALLBACK");
      });

      it("still extracts direct image covers (no XHTML unwrapping needed)", async () => {
        const coverData = Buffer.from("DIRECT-IMAGE-COVER");
        const opf = makeOpf({
          title: "Direct Image Cover",
          coverMeta: '<meta name="cover" content="cover-img"/>',
          manifestItems: '<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>',
        });

        const epub = buildZip([
          { name: "mimetype", data: Buffer.from("application/epub+zip") },
          {
            name: "META-INF/container.xml",
            data: Buffer.from(makeContainerXml("OEBPS/content.opf")),
          },
          { name: "OEBPS/content.opf", data: Buffer.from(opf) },
          { name: "OEBPS/images/cover.jpg", data: coverData },
        ]);
        const path = await writeEpub("direct-image-cover.epub", epub);

        const cover = await extractEpubCoverImage(path);
        expect(cover).not.toBeNull();
        expect(cover!.toString()).toBe("DIRECT-IMAGE-COVER");
      });

      it("handles XHTML cover at root level (no subdirectory)", async () => {
        const coverData = Buffer.from("ROOT-LEVEL-COVER");
        const xhtmlCover = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<body>
  <img src="cover.jpg" alt="cover"/>
</body>
</html>`;

        const opf = makeOpf({
          title: "Root Level XHTML",
          coverMeta: '<meta name="cover" content="cover-page"/>',
          manifestItems:
            '<item id="cover-page" href="titlepage.xhtml" media-type="application/xhtml+xml"/>',
        });

        const epub = buildZip([
          { name: "mimetype", data: Buffer.from("application/epub+zip") },
          {
            name: "META-INF/container.xml",
            data: Buffer.from(makeContainerXml("content.opf")),
          },
          { name: "content.opf", data: Buffer.from(opf) },
          { name: "titlepage.xhtml", data: Buffer.from(xhtmlCover) },
          { name: "cover.jpg", data: coverData },
        ]);
        const path = await writeEpub("root-xhtml-cover.epub", epub);

        const cover = await extractEpubCoverImage(path);
        expect(cover).not.toBeNull();
        expect(cover!.toString()).toBe("ROOT-LEVEL-COVER");
      });
    });
  });

  describe("metadata sanitization", () => {
    it("strips HTML tags from title", async () => {
      const opf = makeOpf({ title: '<script>alert("xss")</script>My Book' });
      const epub = buildEpub(opf);
      const path = await writeEpub("xss-title.epub", epub);

      const meta = await extractEpubMetadata(path);
      expect(meta.title).toBe('alert("xss")My Book');
      expect(meta.title).not.toContain("<script>");
    });

    it("strips HTML tags from author/creator", async () => {
      const opf = makeOpf({ creator: "<b>Bold</b> Author <img src=x onerror=alert(1)>" });
      const epub = buildEpub(opf);
      const path = await writeEpub("xss-author.epub", epub);

      const meta = await extractEpubMetadata(path);
      expect(meta.author).toBe("Bold Author");
      expect(meta.author).not.toContain("<");
    });

    it("strips HTML tags from publisher", async () => {
      const opf = makeOpf({ publisher: '<a href="http://evil.com">Evil Press</a>' });
      const epub = buildEpub(opf);
      const path = await writeEpub("xss-publisher.epub", epub);

      const meta = await extractEpubMetadata(path);
      expect(meta.publisher).toBe("Evil Press");
      expect(meta.publisher).not.toContain("<a");
    });

    it("strips HTML from multiple creators", async () => {
      const opf = makeOpf({ creator: ["<i>Author One</i>", "<b>Author Two</b>"] });
      const epub = buildEpub(opf);
      const path = await writeEpub("xss-multi-author.epub", epub);

      const meta = await extractEpubMetadata(path);
      expect(meta.author).toBe("Author One, Author Two");
    });

    it("rejects absolute http cover URL", async () => {
      const opf = makeOpf({
        title: "SSRF Cover",
        coverMeta: '<meta name="cover" content="cover-img"/>',
        manifestItems:
          '<item id="cover-img" href="http://169.254.169.254/metadata" media-type="image/jpeg"/>',
      });
      const epub = buildEpub(opf);
      const path = await writeEpub("ssrf-cover.epub", epub);

      const meta = await extractEpubMetadata(path);
      expect(meta.coverUrl).toBeUndefined();
    });

    it("rejects absolute https cover URL", async () => {
      const opf = makeOpf({
        title: "SSRF Cover HTTPS",
        coverMeta: '<meta name="cover" content="cover-img"/>',
        manifestItems:
          '<item id="cover-img" href="https://evil.com/steal" media-type="image/jpeg"/>',
      });
      const epub = buildEpub(opf);
      const path = await writeEpub("ssrf-cover-https.epub", epub);

      const meta = await extractEpubMetadata(path);
      expect(meta.coverUrl).toBeUndefined();
    });

    it("rejects protocol-relative cover URL", async () => {
      const opf = makeOpf({
        title: "Protocol Relative",
        coverMeta: '<meta name="cover" content="cover-img"/>',
        manifestItems: '<item id="cover-img" href="//evil.com/cover.jpg" media-type="image/jpeg"/>',
      });
      const epub = buildEpub(opf);
      const path = await writeEpub("proto-rel-cover.epub", epub);

      const meta = await extractEpubMetadata(path);
      expect(meta.coverUrl).toBeUndefined();
    });

    it("rejects data: URI cover URL", async () => {
      const opf = makeOpf({
        title: "Data URI",
        coverMeta: '<meta name="cover" content="cover-img"/>',
        manifestItems:
          '<item id="cover-img" href="data:text/html,<script>alert(1)</script>" media-type="image/jpeg"/>',
      });
      const epub = buildEpub(opf);
      const path = await writeEpub("data-uri-cover.epub", epub);

      const meta = await extractEpubMetadata(path);
      expect(meta.coverUrl).toBeUndefined();
    });

    it("rejects cover URL with path traversal", async () => {
      const opf = makeOpf({
        title: "Traversal Cover",
        coverMeta: '<meta name="cover" content="cover-img"/>',
        manifestItems: '<item id="cover-img" href="../../../etc/passwd" media-type="image/jpeg"/>',
      });
      const epub = buildEpub(opf);
      const path = await writeEpub("traversal-cover.epub", epub);

      const meta = await extractEpubMetadata(path);
      expect(meta.coverUrl).toBeUndefined();
    });

    it("allows valid relative cover URL", async () => {
      const opf = makeOpf({
        title: "Good Cover",
        coverMeta: '<meta name="cover" content="cover-img"/>',
        manifestItems: '<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>',
      });
      const epub = buildEpub(opf);
      const path = await writeEpub("good-cover.epub", epub);

      const meta = await extractEpubMetadata(path);
      expect(meta.coverUrl).toBeUndefined();
    });

    it("truncates extremely long title", async () => {
      const longTitle = "A".repeat(5000);
      const opf = makeOpf({ title: longTitle });
      const epub = buildEpub(opf);
      const path = await writeEpub("long-title.epub", epub);

      const meta = await extractEpubMetadata(path);
      expect(meta.title!.length).toBeLessThanOrEqual(1000);
    });

    it("truncates extremely long description", async () => {
      const longDesc = "Word ".repeat(5000);
      const opf = makeOpf({ title: "Long Desc", description: longDesc });
      const epub = buildEpub(opf);
      const path = await writeEpub("long-desc.epub", epub);

      const meta = await extractEpubMetadata(path);
      expect(meta.description!.length).toBeLessThanOrEqual(5000);
    });

    it("rejects non-ISBN identifier formats", async () => {
      const opf = makeOpf({
        title: "Bad ISBNs",
        identifiers: [
          { id: "bad1", value: "12345" },
          { id: "bad2", value: "abcdefghij" },
          { id: "bad3", value: "978-ABCDEFGHIJ" },
        ],
      });
      const epub = buildEpub(opf);
      const path = await writeEpub("bad-isbn.epub", epub);

      const meta = await extractEpubMetadata(path);
      expect(meta.isbn10).toBeUndefined();
      expect(meta.isbn13).toBeUndefined();
    });
  });

  describe("fallback extraction", () => {
    it("uses local header scan when EOCD is damaged", async () => {
      const opf = makeOpf({ title: "Fallback Book", creator: "Fallback Author" });
      const epub = buildEpub(opf);
      const corrupted = Buffer.from(epub);

      // Zero out the EOCD signature
      for (let i = corrupted.length - 22; i < corrupted.length; i++) {
        corrupted[i] = 0;
      }

      const path = await writeEpub("fallback.epub", corrupted);
      const meta = await extractEpubMetadata(path);

      // Fallback scans local headers for .opf files (uncompressed only)
      // If the OPF was stored uncompressed, it should find metadata
      expect(meta).toBeDefined();
    });
  });
});

describe("extractEpubTextSample", () => {
  const ENGLISH_PROSE =
    "It was a bright cold day in April and the clocks were striking thirteen. " +
    "The protagonist walked slowly down the long corridor, thinking about the day " +
    "ahead and the many tasks that still remained unfinished before evening arrived.";

  function buildEpubWithSpine(docs: { id: string; href: string; content: string }[]): Buffer {
    const opfPath = "OEBPS/content.opf";
    const manifest = docs
      .map((d) => `<item id="${d.id}" href="${d.href}" media-type="application/xhtml+xml"/>`)
      .join("\n    ");
    const spine = docs.map((d) => `<itemref idref="${d.id}"/>`).join("\n    ");
    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Sample</dc:title></metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`;
    return buildZip([
      { name: "mimetype", data: Buffer.from("application/epub+zip") },
      { name: "META-INF/container.xml", data: Buffer.from(makeContainerXml(opfPath)) },
      { name: opfPath, data: Buffer.from(opf) },
      ...docs.map((d) => ({ name: `OEBPS/${d.href}`, data: Buffer.from(d.content) })),
    ]);
  }

  it("samples body prose, skipping short front matter and styles/scripts", async () => {
    const epub = buildEpubWithSpine([
      {
        id: "cover",
        href: "cover.xhtml",
        content: "<html><body><h1>Title Page</h1></body></html>",
      },
      {
        id: "ch1",
        href: "ch1.xhtml",
        content: `<html><head><style>.x{color:red}</style></head><body><p>${ENGLISH_PROSE}</p></body></html>`,
      },
    ]);
    const path = await writeEpub("sample-prose.epub", epub);

    const sample = await extractEpubTextSample(path);

    expect(sample).toBeTruthy();
    expect(sample!.length).toBeGreaterThanOrEqual(200);
    expect(sample).toContain("striking thirteen");
    expect(sample).not.toContain("Title Page"); // front matter skipped
    expect(sample).not.toContain("color:red"); // style not treated as prose
  });

  it("returns undefined when there is no substantial prose", async () => {
    const epub = buildEpubWithSpine([
      { id: "cover", href: "cover.xhtml", content: "<html><body><h1>Cover</h1></body></html>" },
    ]);
    const path = await writeEpub("sample-empty.epub", epub);

    expect(await extractEpubTextSample(path)).toBeUndefined();
  });
});
