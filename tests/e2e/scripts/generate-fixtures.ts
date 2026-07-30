/**
 * Generate minimal but valid EPUB and PDF test fixtures.
 *
 * Run:  npx tsx tests/e2e/scripts/generate-fixtures.ts
 *
 * Produces:
 *   tests/e2e/fixtures/test-book.epub  (~5 KB)  — title, author, ISBN, cover, genres
 *   tests/e2e/fixtures/test-book.pdf   (~2 KB)  — title, author in Info dict
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { deflateRawSync } from "node:zlib";

const FIXTURES_DIR = join(dirname(import.meta.dirname!), "fixtures");

// ---------------------------------------------------------------------------
// Shared ZIP builder (same approach as packages/metadata epub.test.ts)
// ---------------------------------------------------------------------------

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

interface ZipEntry {
  name: string;
  data: Buffer;
  compress?: boolean;
}

function buildZip(entries: ZipEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const uncompressed = entry.data;
    const compressed = entry.compress ? deflateRawSync(uncompressed) : uncompressed;
    const compression = entry.compress ? 8 : 0;
    const crc = crc32(uncompressed);

    const local = Buffer.alloc(30 + nameBytes.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(compression, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    compressed.copy(local, 30 + nameBytes.length);

    const central = Buffer.alloc(46 + nameBytes.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(compression, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBytes.copy(central, 46);

    localHeaders.push(local);
    centralHeaders.push(central);
    offset += local.length;
  }

  const cdData = Buffer.concat(centralHeaders);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdData.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localHeaders, cdData, eocd]);
}

// ---------------------------------------------------------------------------
// Minimal 1×1 red JPEG (smallest valid JFIF)
// ---------------------------------------------------------------------------

function make1x1Jpeg(): Buffer {
  // Minimal JFIF: SOI + APP0 + DQT + SOF0 + DHT(DC) + DHT(AC) + SOS + data + EOI
  // This is a hand-crafted minimal valid JPEG that decodes to a 1×1 red pixel.
  return Buffer.from(
    "ffd8ffe000104a46494600010100000100010000" + // SOI + APP0 (JFIF)
      "ffdb004300080606070605080707070909080a0c140d0c0b0b0c1912130f141d1a1f1e1d1a1c1c20242e2720222c231c1c2837292c30313434341f27393d38323c2e333432" + // DQT
      "ffc0000b08000100010101011100" + // SOF0: 1×1, 1 component
      "ffc4001f0000010501010101010100000000000000000102030405060708090a0b" + // DHT DC
      "ffc400b5100002010303020403050504040000017d01020300041105122131410613516107227114328191a1082342b1c11552d1f02433627282090a161718191a25262728292a3435363738393a434445464748494a535455565758595a636465666768696a737475767778797a838485868788898a92939495969798999aa2a3a4a5a6a7a8a9aab2b3b4b5b6b7b8b9bac2c3c4c5c6c7c8c9cad2d3d4d5d6d7d8d9dae1e2e3e4e5e6e7e8e9eaf1f2f3f4f5f6f7f8f9fa" + // DHT AC
      "ffda00080101000003f400fbd2800fffd9", // SOS + minimal scan data + EOI
    "hex",
  );
}

// ---------------------------------------------------------------------------
// EPUB fixture
// ---------------------------------------------------------------------------

function buildEpub(): Buffer {
  const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="isbn13">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>The Art of Testing</dc:title>
    <dc:creator>Jane Testworth</dc:creator>
    <dc:publisher>Fixture Press</dc:publisher>
    <dc:language>en</dc:language>
    <dc:description>A minimal EPUB fixture for E2E testing.</dc:description>
    <dc:subject>Software Testing</dc:subject>
    <dc:subject>Quality Assurance</dc:subject>
    <dc:subject>Fiction</dc:subject>
    <dc:date>2024-01-15</dc:date>
    <dc:identifier id="isbn13" opf:scheme="ISBN">9781234567890</dc:identifier>
    <dc:identifier id="isbn10">1234567890</dc:identifier>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>
    <item id="chapter1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="toc" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
  </manifest>
  <spine toc="toc">
    <itemref idref="chapter1"/>
  </spine>
</package>`;

  const chapter1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
  <h1>Chapter 1: Getting Started</h1>
  <p>This is a minimal test book for E2E testing.</p>
</body>
</html>`;

  const tocNcx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="9781234567890"/></head>
  <docTitle><text>The Art of Testing</text></docTitle>
  <navMap>
    <navPoint id="ch1" playOrder="1">
      <navLabel><text>Chapter 1</text></navLabel>
      <content src="chapter1.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`;

  return buildZip([
    { name: "mimetype", data: Buffer.from("application/epub+zip") },
    { name: "META-INF/container.xml", data: Buffer.from(containerXml), compress: true },
    { name: "OEBPS/content.opf", data: Buffer.from(opf), compress: true },
    { name: "OEBPS/chapter1.xhtml", data: Buffer.from(chapter1), compress: true },
    { name: "OEBPS/toc.ncx", data: Buffer.from(tocNcx), compress: true },
    { name: "OEBPS/images/cover.jpg", data: make1x1Jpeg() },
  ]);
}

// ---------------------------------------------------------------------------
// PDF fixture
// ---------------------------------------------------------------------------

function buildPdf(): Buffer {
  // Build a minimal but spec-compliant PDF 1.4 with Info dictionary metadata.
  // Includes: Catalog → Pages → Page with a simple text stream.
  const lines: string[] = [];
  const offsets: number[] = [];
  let pos = 0;

  function emit(line: string) {
    lines.push(line);
    pos += Buffer.byteLength(line + "\n", "latin1");
  }

  emit("%PDF-1.4");
  // Binary comment to signal binary content (per spec recommendation)
  emit("%\xe2\xe3\xcf\xd3");

  // Object 1: Info dictionary
  offsets[1] = pos;
  emit("1 0 obj");
  emit("<<");
  emit("/Title (The PDF Testing Guide)");
  emit("/Author (John Fixture)");
  emit("/Subject (A minimal PDF fixture for E2E testing)");
  emit("/Keywords (testing, e2e, fixture)");
  emit("/Creator (generate-fixtures.ts)");
  emit("/CreationDate (D:20240115120000+00'00')");
  emit(">>");
  emit("endobj");

  // Object 2: Catalog
  offsets[2] = pos;
  emit("2 0 obj");
  emit("<< /Type /Catalog /Pages 3 0 R >>");
  emit("endobj");

  // Object 3: Pages tree
  offsets[3] = pos;
  emit("3 0 obj");
  emit("<< /Type /Pages /Kids [4 0 R] /Count 1 >>");
  emit("endobj");

  // Object 4: Page
  offsets[4] = pos;
  emit("4 0 obj");
  emit("<<");
  emit("  /Type /Page");
  emit("  /Parent 3 0 R");
  emit("  /MediaBox [0 0 612 792]");
  emit("  /Contents 5 0 R");
  emit("  /Resources << /Font << /F1 6 0 R >> >>");
  emit(">>");
  emit("endobj");

  // Object 5: Page content stream
  const streamContent = "BT /F1 24 Tf 72 720 Td (The PDF Testing Guide) Tj ET";
  offsets[5] = pos;
  emit("5 0 obj");
  emit(`<< /Length ${streamContent.length} >>`);
  emit("stream");
  emit(streamContent);
  emit("endstream");
  emit("endobj");

  // Object 6: Font
  offsets[6] = pos;
  emit("6 0 obj");
  emit("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  emit("endobj");

  // Cross-reference table
  const xrefOffset = pos;
  emit("xref");
  emit(`0 ${offsets.length}`);
  emit("0000000000 65535 f ");
  for (let i = 1; i < offsets.length; i++) {
    emit(`${String(offsets[i]).padStart(10, "0")} 00000 n `);
  }

  // Trailer
  emit("trailer");
  emit(`<< /Size ${offsets.length} /Root 2 0 R /Info 1 0 R >>`);
  emit("startxref");
  emit(String(xrefOffset));
  emit("%%EOF");

  return Buffer.from(lines.join("\n") + "\n", "latin1");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

mkdirSync(FIXTURES_DIR, { recursive: true });

const epubData = buildEpub();
const epubPath = join(FIXTURES_DIR, "test-book.epub");
writeFileSync(epubPath, epubData);
console.log(`EPUB: ${epubPath} (${epubData.length} bytes)`);

const pdfData = buildPdf();
const pdfPath = join(FIXTURES_DIR, "test-book.pdf");
writeFileSync(pdfPath, pdfData);
console.log(`PDF:  ${pdfPath} (${pdfData.length} bytes)`);

console.log("Done.");
