import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { HTTPException } from "hono/http-exception";

/**
 * Asserts that `filePath` resolves within `root`, preventing path traversal attacks.
 * Checks both the pre-resolution path and the canonical resolved path.
 * Throws HTTPException(403) if either check fails.
 */
export function assertPathWithinRoot(filePath: string, root: string): void {
  const canonicalRoot = root.endsWith(sep) ? root : root + sep;
  if (!filePath.startsWith(canonicalRoot)) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
  const canonical = realpathSync(filePath);
  if (!canonical.startsWith(canonicalRoot)) {
    throw new HTTPException(403, { message: "Forbidden" });
  }
}
