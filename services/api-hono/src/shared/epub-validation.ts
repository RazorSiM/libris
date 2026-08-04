const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const EPUB_MIMETYPE = Buffer.from("application/epub+zip", "ascii");

/** Validate the deterministic EPUB container signature before it reaches parsers. */
export function validateEpubUpload(data: Uint8Array): string | null {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buffer.length === 0) return "EPUB file is empty";
  if (buffer.length < 30 || buffer.readUInt32LE(0) !== LOCAL_FILE_HEADER) {
    return "EPUB must be a ZIP archive with mimetype as its first entry";
  }

  const compression = buffer.readUInt16LE(8);
  const compressedSize = buffer.readUInt32LE(18);
  const uncompressedSize = buffer.readUInt32LE(22);
  const nameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);
  const nameStart = 30;
  const dataStart = nameStart + nameLength + extraLength;
  if (dataStart > buffer.length) return "EPUB has a truncated first ZIP entry";

  const name = buffer.subarray(nameStart, nameStart + nameLength).toString("utf8");
  if (name !== "mimetype" || compression !== 0 || extraLength !== 0) {
    return "EPUB first entry must be an uncompressed mimetype file with no extra fields";
  }
  if (
    compressedSize !== EPUB_MIMETYPE.length ||
    uncompressedSize !== EPUB_MIMETYPE.length ||
    dataStart + EPUB_MIMETYPE.length > buffer.length ||
    !buffer.subarray(dataStart, dataStart + EPUB_MIMETYPE.length).equals(EPUB_MIMETYPE)
  ) {
    return "EPUB mimetype entry must contain application/epub+zip";
  }

  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset--) {
    if (buffer.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) return "EPUB ZIP archive is missing its central directory";
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const directorySize = buffer.readUInt32LE(eocdOffset + 12);
  const directoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (
    entryCount === 0 ||
    directoryOffset + directorySize > eocdOffset ||
    directoryOffset + 46 > buffer.length ||
    buffer.readUInt32LE(directoryOffset) !== CENTRAL_DIRECTORY_HEADER
  ) {
    return "EPUB ZIP central directory is invalid";
  }
  const firstDirectoryNameLength = buffer.readUInt16LE(directoryOffset + 28);
  const firstDirectoryName = buffer
    .subarray(directoryOffset + 46, directoryOffset + 46 + firstDirectoryNameLength)
    .toString("utf8");
  if (firstDirectoryName !== "mimetype" || buffer.readUInt32LE(directoryOffset + 42) !== 0) {
    return "EPUB central directory does not reference the first mimetype entry";
  }
  return null;
}
