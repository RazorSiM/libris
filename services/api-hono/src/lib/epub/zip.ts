import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { crc32 as zlibCrc32, deflateRawSync, inflateRaw } from "node:zlib";

// ZIP format constants
export const EOCD_SIG = 0x06054b50;
export const CD_SIG = 0x02014b50;
export const LOCAL_HEADER_SIG = 0x04034b50;
export const EOCD_MIN_SIZE = 22;
export const EOCD_MAX_COMMENT = 65535;
export const MAX_ZIP_ENTRY_BYTES = 16 * 1024 * 1024;
export const MAX_ZIP_ARCHIVE_BYTES = 64 * 1024 * 1024;

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipLimitError";
  }
}

export interface ZipEntry {
  fileName: string;
  compression: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

// --- Byte reading helpers ---

export async function readRange(filePath: string, start: number, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve(Buffer.concat(chunks));
      }
    };
    const stream = createReadStream(filePath, {
      start,
      end: start + length - 1,
      highWaterMark: 8192,
    });
    stream.on("data", (chunk: string | Buffer) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    stream.on("end", done);
    stream.on("close", done);
    stream.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
  });
}

// --- EOCD & Central Directory parsing ---

export function findEocd(buf: Buffer): number {
  for (let i = buf.length - EOCD_MIN_SIZE; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

export function parseCentralDirectory(buf: Buffer, cdSize: number): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let pos = 0;

  while (pos + 46 <= cdSize && pos + 46 <= buf.length) {
    if (buf.readUInt32LE(pos) !== CD_SIG) break;

    const compression = buf.readUInt16LE(pos + 10);
    const compressedSize = buf.readUInt32LE(pos + 20);
    const uncompressedSize = buf.readUInt32LE(pos + 24);
    const fileNameLength = buf.readUInt16LE(pos + 28);
    const extraLength = buf.readUInt16LE(pos + 30);
    const commentLength = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);

    const fileNameStart = pos + 46;
    if (fileNameStart + fileNameLength > buf.length) break;

    const fileName = buf.subarray(fileNameStart, fileNameStart + fileNameLength).toString("utf8");

    entries.push({
      fileName,
      compression,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    pos = fileNameStart + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

interface ReadZipEntryOptions {
  maxOutputBytes?: number;
  label?: string;
}

export async function readZipEntry(
  filePath: string,
  entry: ZipEntry,
  options: ReadZipEntryOptions = {},
): Promise<Buffer | null> {
  const maxOutputBytes = options.maxOutputBytes ?? MAX_ZIP_ENTRY_BYTES;
  const label = options.label ?? `ZIP entry ${JSON.stringify(entry.fileName)}`;
  if (entry.uncompressedSize > maxOutputBytes) {
    throw new ZipLimitError(`${label} exceeds the ${maxOutputBytes}-byte uncompressed size limit`);
  }

  // Read local file header to get the actual data offset (extra field may differ from CD)
  const headerSize = 30 + 512; // 30 fixed + generous room for filename + extra
  const headerBuf = await readRange(filePath, entry.localHeaderOffset, headerSize);

  if (headerBuf.length < 30 || headerBuf.readUInt32LE(0) !== LOCAL_HEADER_SIG) return null;

  const fileNameLength = headerBuf.readUInt16LE(26);
  const extraLength = headerBuf.readUInt16LE(28);
  const dataOffset = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
  const readSize = entry.compressedSize || entry.uncompressedSize;

  if (readSize === 0) return Buffer.alloc(0);

  const dataBuf = await readRange(filePath, dataOffset, readSize);

  if (entry.compression === 0) {
    if (dataBuf.length > maxOutputBytes) {
      throw new ZipLimitError(`${label} exceeds the ${maxOutputBytes}-byte output limit`);
    }
    return dataBuf;
  }
  if (entry.compression === 8) {
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        inflateRaw(dataBuf, { maxOutputLength: maxOutputBytes }, (error, result) => {
          if (error) reject(error);
          else resolve(result);
        });
      });
    } catch (error: unknown) {
      if (
        (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" ||
        String(error).includes("maxOutputLength")
      ) {
        throw new ZipLimitError(`${label} exceeds the ${maxOutputBytes}-byte output limit`);
      }
      return null;
    }
  }
  return null; // unsupported compression
}

// --- Read all ZIP entries into memory ---

export async function readAllZipEntries(
  filePath: string,
  options: { maxEntryBytes?: number; maxTotalBytes?: number } = {},
): Promise<{ entries: ZipEntry[]; rawEntries: Map<string, Buffer> }> {
  const maxEntryBytes = options.maxEntryBytes ?? MAX_ZIP_ENTRY_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_ZIP_ARCHIVE_BYTES;
  const fileInfo = await stat(filePath);
  const fileSize = Number(fileInfo.size);
  if (fileSize < EOCD_MIN_SIZE) {
    throw new Error("File too small to be a valid ZIP");
  }

  const tailSize = Math.min(fileSize, EOCD_MIN_SIZE + EOCD_MAX_COMMENT);
  const tailOffset = fileSize - tailSize;
  const tailBuf = await readRange(filePath, tailOffset, tailSize);

  const eocdPos = findEocd(tailBuf);
  if (eocdPos === -1) {
    throw new Error("Could not find EOCD signature — not a valid ZIP");
  }

  const cdSize = tailBuf.readUInt32LE(eocdPos + 12);
  const cdOffset = tailBuf.readUInt32LE(eocdPos + 16);

  const cdBuf = await readRange(filePath, cdOffset, cdSize);
  const entries = parseCentralDirectory(cdBuf, cdSize);

  let declaredTotal = 0;
  for (const entry of entries) {
    if (entry.uncompressedSize > maxEntryBytes) {
      throw new ZipLimitError(
        `ZIP entry ${JSON.stringify(entry.fileName)} exceeds the ${maxEntryBytes}-byte uncompressed size limit`,
      );
    }
    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > maxTotalBytes) {
      throw new ZipLimitError(`ZIP archive exceeds the ${maxTotalBytes}-byte output budget`);
    }
  }

  const rawEntries = new Map<string, Buffer>();
  let actualTotal = 0;
  for (const entry of entries) {
    const data = await readZipEntry(filePath, entry, { maxOutputBytes: maxEntryBytes });
    if (data) {
      actualTotal += data.length;
      if (actualTotal > maxTotalBytes) {
        throw new ZipLimitError(`ZIP archive exceeds the ${maxTotalBytes}-byte output budget`);
      }
      rawEntries.set(entry.fileName, data);
    }
  }

  return { entries, rawEntries };
}

// --- CRC-32 ---

export function crc32(buf: Buffer): number {
  return zlibCrc32(buf);
}

// --- ZIP builder ---

export interface ZipBuildEntry {
  name: string;
  data: Buffer;
  /** Use DEFLATE compression. Default: true (except for "mimetype" which is always STORE). */
  compress?: boolean;
}

/**
 * Build a valid ZIP buffer from entries.
 * The "mimetype" entry (if present) is always stored first and uncompressed per EPUB spec.
 */
export function buildZip(entries: ZipBuildEntry[]): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const uncompressed = entry.data;

    // mimetype must be STORE per EPUB spec; others default to compress
    const isMimetype = entry.name === "mimetype";
    const shouldCompress = isMimetype ? false : (entry.compress ?? true);
    const compressed = shouldCompress ? deflateRawSync(uncompressed) : uncompressed;
    const compression = shouldCompress ? 8 : 0;
    const crcVal = crc32(uncompressed);

    // Local file header
    const local = Buffer.alloc(30 + nameBytes.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(compression, 8);
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crcVal, 14);
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
    central.writeUInt32LE(crcVal, 16);
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
