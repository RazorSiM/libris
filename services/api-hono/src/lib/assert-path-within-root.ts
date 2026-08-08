import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { HTTPException } from "hono/http-exception";

export class PathOutsideRootError extends Error {
  constructor() {
    super("Path is outside the allowed root");
    this.name = "PathOutsideRootError";
  }
}

export class PathNotFoundError extends Error {
  constructor() {
    super("Path does not exist");
    this.name = "PathNotFoundError";
  }
}

function isWithinRoot(filePath: string, root: string): boolean {
  const fromRoot = relative(root, filePath);
  return fromRoot !== "" && !fromRoot.startsWith("..") && !isAbsolute(fromRoot);
}

/**
 * Assert an untrusted, existing path resolves to a file below `root`.
 *
 * This filesystem-only form is suitable for workers and deliberately does not
 * throw an HTTP-specific error.
 */
export function assertExistingPathWithinRoot(filePath: string, root: string): void {
  if (!isAbsolute(filePath)) {
    throw new PathOutsideRootError();
  }

  const lexicalRoot = resolve(root);
  if (!isWithinRoot(resolve(filePath), lexicalRoot)) {
    throw new PathOutsideRootError();
  }

  const canonicalRoot = realpathSync(root);
  let canonical: string;
  try {
    canonical = realpathSync(filePath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new PathNotFoundError();
    }
    throw error;
  }

  if (!isWithinRoot(canonical, canonicalRoot)) {
    throw new PathOutsideRootError();
  }
}

/**
 * Asserts that `filePath` resolves within `root`, preventing path traversal attacks.
 * Checks both the pre-resolution path and the canonical resolved path.
 * Maps missing paths to HTTP 404 and paths outside the root to HTTP 403.
 */
export function assertPathWithinRoot(filePath: string, root: string): void {
  try {
    assertExistingPathWithinRoot(filePath, root);
  } catch (error: unknown) {
    if (error instanceof PathNotFoundError) {
      throw new HTTPException(404, { message: "File not found on disk" });
    }
    if (error instanceof PathOutsideRootError) {
      throw new HTTPException(403, { message: "Forbidden" });
    }
    throw error;
  }
}
