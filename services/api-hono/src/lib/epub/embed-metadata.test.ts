import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { embedEpubMetadata } from "./embed-metadata";
import type { EpubEmbedMetadata } from "./embed-metadata";
import { buildZip } from "./zip";

// --- Test helpers ---

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
  extraMeta?: string;
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
    ${meta.extraMeta ?? ""}
  </metadata>
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    ${meta.manifestItems ?? ""}
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>`;
}

function buildEpub(
  opfContent: string,
  opfPath = "OEBPS/content.opf",
  extraEntries: { name: string; data: Buffer }[] = [],
): Buffer {
  return buildZip([
    { name: "mimetype", data: Buffer.from("application/epub+zip"), compress: false },
    {
      name: "META-INF/container.xml",
      data: Buffer.from(makeContainerXml(opfPath)),
      compress: false,
    },
    { name: opfPath, data: Buffer.from(opfContent), compress: false },
    ...extraEntries.map((e) => ({ ...e, compress: false as const })),
  ]);
}

/** Extract OPF XML from the EPUB at filePath using our zip utilities */
async function readOpfFromEpub(filePath: string): Promise<string> {
  const { readAllZipEntries } = await import("./zip");
  const { rawEntries } = await readAllZipEntries(filePath);

  const containerXml = rawEntries.get("META-INF/container.xml");
  let opfPath: string | null = null;
  if (containerXml) {
    const match = containerXml.toString("utf8").match(/<rootfile[^>]+full-path="([^"]+)"[^>]*>/i);
    opfPath = match?.[1] ?? null;
  }
  if (!opfPath || !rawEntries.has(opfPath)) {
    opfPath = [...rawEntries.keys()].find((k) => k.endsWith(".opf")) ?? null;
  }
  if (!opfPath) throw new Error("No OPF found in rebuilt EPUB");

  return rawEntries.get(opfPath)!.toString("utf8");
}

/** Read all entries from an EPUB file */
async function readEntriesFromEpub(filePath: string): Promise<Map<string, Buffer>> {
  const { readAllZipEntries } = await import("./zip");
  const { rawEntries } = await readAllZipEntries(filePath);
  return rawEntries;
}

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "embed-meta-test-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeEpub(name: string, data: Buffer): Promise<string> {
  const filePath = join(tmpDir, name);
  await writeFile(filePath, data);
  return filePath;
}

describe("embedEpubMetadata", () => {
  it("embeds all metadata fields correctly", async () => {
    const opf = makeOpf({ title: "Old Title", creator: "Old Author" });
    const epub = buildEpub(opf);
    const path = await writeEpub("full-meta.epub", epub);

    const metadata: EpubEmbedMetadata = {
      title: "New Title",
      author: "New Author",
      isbn10: "1234567890",
      isbn13: "9781234567890",
      publisher: "New Press",
      publishedYear: 2025,
      language: "en",
      description: "A great book about testing",
      genres: ["Fiction", "Science Fiction"],
    };

    await embedEpubMetadata(path, metadata);

    const opfXml = await readOpfFromEpub(path);
    expect(opfXml).toContain("<dc:title>New Title</dc:title>");
    expect(opfXml).toContain("<dc:creator>New Author</dc:creator>");
    expect(opfXml).toContain("<dc:publisher>New Press</dc:publisher>");
    expect(opfXml).toContain("<dc:language>en</dc:language>");
    expect(opfXml).toContain("<dc:description>A great book about testing</dc:description>");
    expect(opfXml).toContain("<dc:date>2025</dc:date>");
    expect(opfXml).toContain("urn:isbn:9781234567890");
    expect(opfXml).toContain('<dc:identifier id="isbn10">1234567890</dc:identifier>');
    expect(opfXml).toContain("<dc:subject>Fiction</dc:subject>");
    expect(opfXml).toContain("<dc:subject>Science Fiction</dc:subject>");
    // Old metadata should be gone
    expect(opfXml).not.toContain("Old Title");
    expect(opfXml).not.toContain("Old Author");
  });

  it("preserves non-metadata content (manifest, spine)", async () => {
    const opf = makeOpf({ title: "Preserve Test" });
    const epub = buildEpub(opf);
    const path = await writeEpub("preserve.epub", epub);

    await embedEpubMetadata(path, { title: "Updated" });

    const opfXml = await readOpfFromEpub(path);
    expect(opfXml).toContain("<manifest>");
    expect(opfXml).toContain("chapter1.xhtml");
    expect(opfXml).toContain("<spine>");
    expect(opfXml).toContain('<itemref idref="chapter1"/>');
  });

  it("preserves non-DC metadata elements", async () => {
    const opf = makeOpf({
      title: "Has Meta",
      extraMeta:
        '<meta name="calibre:series" content="Test Series"/>\n    <meta name="calibre:series_index" content="1"/>',
    });
    const epub = buildEpub(opf);
    const path = await writeEpub("non-dc.epub", epub);

    await embedEpubMetadata(path, { title: "Updated Title" });

    const opfXml = await readOpfFromEpub(path);
    expect(opfXml).toContain("<dc:title>Updated Title</dc:title>");
    expect(opfXml).toContain("calibre:series");
    expect(opfXml).toContain("Test Series");
    expect(opfXml).toContain("calibre:series_index");
  });

  it("handles epub with existing metadata (replacement, not duplication)", async () => {
    const opf = makeOpf({
      title: "Original",
      creator: "Original Author",
      publisher: "Original Press",
      language: "fr",
      subjects: ["Old Genre"],
    });
    const epub = buildEpub(opf);
    const path = await writeEpub("replace.epub", epub);

    await embedEpubMetadata(path, {
      title: "Replaced",
      author: "Replaced Author",
      publisher: "Replaced Press",
      language: "en",
      genres: ["New Genre"],
    });

    const opfXml = await readOpfFromEpub(path);
    // New values present
    expect(opfXml).toContain("<dc:title>Replaced</dc:title>");
    expect(opfXml).toContain("<dc:creator>Replaced Author</dc:creator>");
    // Old values gone
    expect(opfXml).not.toContain("Original");
    expect(opfXml).not.toContain("Old Genre");
    // No duplicates — count occurrences
    const titleCount = (opfXml.match(/<dc:title>/g) || []).length;
    expect(titleCount).toBe(1);
  });

  it("skips gracefully when metadata is empty/null", async () => {
    const opf = makeOpf({ title: "Keep This" });
    const epub = buildEpub(opf);
    const path = await writeEpub("empty-meta.epub", epub);
    const originalContent = await readFile(path);

    await embedEpubMetadata(path, {
      title: null,
      author: null,
      isbn10: null,
      isbn13: null,
    });

    // File should be unchanged (no meaningful metadata to embed)
    const afterContent = await readFile(path);
    expect(afterContent.equals(originalContent)).toBe(true);
  });

  it("mimetype entry stays first and uncompressed", async () => {
    const opf = makeOpf({ title: "Mimetype Test" });
    const epub = buildEpub(opf);
    const path = await writeEpub("mimetype.epub", epub);

    await embedEpubMetadata(path, { title: "Updated" });

    // Read raw bytes to check mimetype is first entry
    const raw = await readFile(path);
    // Local file header signature at offset 0
    expect(raw.readUInt32LE(0)).toBe(0x04034b50);
    // Filename "mimetype" starts at offset 30
    const nameLen = raw.readUInt16LE(26);
    const name = raw.subarray(30, 30 + nameLen).toString("utf8");
    expect(name).toBe("mimetype");
    // Compression method = 0 (STORE)
    expect(raw.readUInt16LE(8)).toBe(0);
  });

  it("keeps deflated entries deflated when rebuilding the EPUB", async () => {
    const opf = makeOpf({ title: "Compression Test" });
    const epub = buildZip([
      { name: "mimetype", data: Buffer.from("application/epub+zip"), compress: false },
      {
        name: "META-INF/container.xml",
        data: Buffer.from(makeContainerXml("content.opf")),
        compress: true,
      },
      { name: "content.opf", data: Buffer.from(opf), compress: true },
      { name: "chapter.xhtml", data: Buffer.alloc(16_384, "a"), compress: true },
    ]);
    const path = await writeEpub("preserve-compression.epub", epub);

    await embedEpubMetadata(path, { title: "Updated" });

    const rebuilt = await readFile(path);
    const eocd = rebuilt.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cdSize = rebuilt.readUInt32LE(eocd + 12);
    const cdOffset = rebuilt.readUInt32LE(eocd + 16);
    const { parseCentralDirectory } = await import("./zip");
    const entries = parseCentralDirectory(rebuilt.subarray(cdOffset, cdOffset + cdSize), cdSize);

    expect(entries.find((entry) => entry.fileName === "chapter.xhtml")?.compression).toBe(8);
    expect(rebuilt.length).toBeLessThan(epub.length * 2);
  });

  it("handles epub with no existing metadata section gracefully", async () => {
    const opfXml = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter1"/>
  </spine>
</package>`;
    const epub = buildEpub(opfXml);
    const path = await writeEpub("no-metadata.epub", epub);

    await embedEpubMetadata(path, { title: "Injected Title", author: "Injected Author" });

    const resultOpf = await readOpfFromEpub(path);
    expect(resultOpf).toContain("<dc:title>Injected Title</dc:title>");
    expect(resultOpf).toContain("<dc:creator>Injected Author</dc:creator>");
    expect(resultOpf).toContain("<metadata");
  });

  it("escapes XML special characters in metadata values", async () => {
    const opf = makeOpf({ title: "Escape Test" });
    const epub = buildEpub(opf);
    const path = await writeEpub("xml-escape.epub", epub);

    await embedEpubMetadata(path, {
      title: 'War & Peace <Extended> "Edition"',
      author: "O'Brien & Sons",
    });

    const opfXml = await readOpfFromEpub(path);
    expect(opfXml).toContain("War &amp; Peace &lt;Extended&gt; &quot;Edition&quot;");
    expect(opfXml).toContain("O&apos;Brien &amp; Sons");
  });

  it("preserves other ZIP entries (chapter files, images, etc.)", async () => {
    const opf = makeOpf({ title: "Preserve Files" });
    const chapterData = Buffer.from("<html><body>Chapter 1</body></html>");
    const imageData = Buffer.from("FAKE-IMAGE-DATA");

    const epub = buildEpub(opf, "OEBPS/content.opf", [
      { name: "OEBPS/chapter1.xhtml", data: chapterData },
      { name: "OEBPS/images/photo.jpg", data: imageData },
    ]);
    const path = await writeEpub("preserve-files.epub", epub);

    await embedEpubMetadata(path, { title: "Updated" });

    const entries = await readEntriesFromEpub(path);
    expect(entries.get("OEBPS/chapter1.xhtml")?.toString()).toBe(
      "<html><body>Chapter 1</body></html>",
    );
    expect(entries.get("OEBPS/images/photo.jpg")?.toString()).toBe("FAKE-IMAGE-DATA");
  });

  describe("cover image embedding", () => {
    it("adds new cover image when none exists", async () => {
      const opf = makeOpf({ title: "No Cover" });
      const epub = buildEpub(opf);
      const path = await writeEpub("add-cover.epub", epub);

      const coverPath = join(tmpDir, "test-cover.jpg");
      const coverData = Buffer.from("JPEG-COVER-DATA");
      await writeFile(coverPath, coverData);

      await embedEpubMetadata(path, { title: "With Cover" }, coverPath);

      const entries = await readEntriesFromEpub(path);
      const opfXml = await readOpfFromEpub(path);

      // Cover image added to ZIP
      expect(entries.has("OEBPS/cover-embedded.jpg")).toBe(true);
      expect(entries.get("OEBPS/cover-embedded.jpg")?.toString()).toBe("JPEG-COVER-DATA");

      // OPF references the cover
      expect(opfXml).toContain('id="cover-embedded"');
      expect(opfXml).toContain('href="cover-embedded.jpg"');
      expect(opfXml).toContain('<meta name="cover" content="cover-embedded"/>');
    });

    it("replaces heuristic cover (cover.jpeg with no OPF metadata) instead of adding duplicate", async () => {
      const oldCoverData = Buffer.from("OLD-HEURISTIC-COVER");
      const opf = makeOpf({ title: "Heuristic Cover" });
      // EPUB has cover.jpeg at root but no OPF cover metadata
      const epub = buildEpub(opf, "content.opf", [{ name: "cover.jpeg", data: oldCoverData }]);
      const path = await writeEpub("heuristic-replace.epub", epub);

      const newCoverPath = join(tmpDir, "downloaded-cover.jpg");
      const newCoverData = Buffer.from("NEW-DOWNLOADED-COVER");
      await writeFile(newCoverPath, newCoverData);

      await embedEpubMetadata(path, { title: "Updated" }, newCoverPath);

      const entries = await readEntriesFromEpub(path);
      const opfXml = await readOpfFromEpub(path);

      // Existing cover.jpeg should be replaced with new data
      expect(entries.get("cover.jpeg")?.toString()).toBe("NEW-DOWNLOADED-COVER");
      // No duplicate cover-embedded.jpg should be added
      expect(entries.has("cover-embedded.jpg")).toBe(false);
      // OPF should now reference cover.jpeg
      expect(opfXml).toContain('href="cover.jpeg"');
      expect(opfXml).toContain('<meta name="cover" content="cover-embedded"/>');
    });

    it("replaces existing cover image", async () => {
      const oldCoverData = Buffer.from("OLD-COVER");
      const opf = makeOpf({
        title: "Has Cover",
        coverMeta: '<meta name="cover" content="cover-img"/>',
        manifestItems: '<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>',
      });
      const epub = buildEpub(opf, "OEBPS/content.opf", [
        { name: "OEBPS/images/cover.jpg", data: oldCoverData },
      ]);
      const path = await writeEpub("replace-cover.epub", epub);

      const newCoverPath = join(tmpDir, "new-cover.jpg");
      const newCoverData = Buffer.from("NEW-COVER");
      await writeFile(newCoverPath, newCoverData);

      await embedEpubMetadata(path, { title: "Updated Cover" }, newCoverPath);

      const entries = await readEntriesFromEpub(path);
      // Old cover path still exists but with new data
      expect(entries.get("OEBPS/images/cover.jpg")?.toString()).toBe("NEW-COVER");
      // No duplicate cover entry
      expect(entries.has("OEBPS/cover-embedded.jpg")).toBe(false);
    });
  });

  it("atomic write: original file unchanged on error", async () => {
    const opf = makeOpf({ title: "Atomic Test" });
    const epub = buildEpub(opf);
    const path = await writeEpub("atomic.epub", epub);
    const originalContent = await readFile(path);

    // Try to embed metadata into a non-existent file (simulates read error)
    const badPath = join(tmpDir, "nonexistent.epub");
    await expect(embedEpubMetadata(badPath, { title: "Should Fail" })).rejects.toThrow();

    // Original file untouched
    const afterContent = await readFile(path);
    expect(afterContent.equals(originalContent)).toBe(true);
  });

  it("round-trip: build → embed → extract yields correct values", async () => {
    const opf = makeOpf({ title: "Round Trip Original", creator: "Original Author" });
    const epub = buildEpub(opf);
    const path = await writeEpub("roundtrip.epub", epub);

    const metadata: EpubEmbedMetadata = {
      title: "Round Trip Updated",
      author: "Updated Author",
      isbn13: "9780596007126",
      publisher: "Test Press",
      publishedYear: 2024,
      language: "en",
      description: "Round trip test",
      genres: ["Testing", "Software"],
    };

    await embedEpubMetadata(path, metadata);

    // Use the existing extraction code to verify
    const { extractEpubMetadata } = await import("../metadata/extractors/epub");
    const extracted = await extractEpubMetadata(path);

    expect(extracted.title).toBe("Round Trip Updated");
    expect(extracted.author).toBe("Updated Author");
    expect(extracted.isbn13).toBe("9780596007126");
    expect(extracted.publisher).toBe("Test Press");
    expect(extracted.publishedYear).toBe(2024);
    expect(extracted.language).toBe("en");
    expect(extracted.description).toBe("Round trip test");
    expect(extracted.genres).toEqual(["Testing", "Software"]);
  });
});
