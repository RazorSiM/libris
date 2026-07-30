import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

/**
 * Compute the same partial MD5 that KoReader uses to identify documents.
 *
 * KoReader samples 1024 bytes at exponentially-spaced offsets using
 * LuaJIT's bit.lshift(1024, 2*i) with 32-bit unsigned wrapping:
 *   i=-1 → offset 0, i=0 → 1024, i=1 → 4096, i=2 → 16384, …
 *
 * If a read at an offset returns nothing, the loop stops.
 * See: koreader/frontend/util.lua → util.partialMD5()
 */
const SAMPLE_SIZE = 1024;

export async function computePartialMd5(filePath: string): Promise<string> {
  const hash = createHash("md5");
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(SAMPLE_SIZE);
    for (let i = -1; i <= 10; i++) {
      // Replicate LuaJIT bit.lshift(1024, 2*i) with 32-bit wrapping
      const shift = (((2 * i) % 32) + 32) % 32;
      const offset = (SAMPLE_SIZE * 2 ** shift) >>> 0;
      const { bytesRead } = await fh.read(buf, 0, SAMPLE_SIZE, offset);
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return hash.digest("hex");
}
