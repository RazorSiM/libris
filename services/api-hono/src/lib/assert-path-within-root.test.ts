import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  assertExistingPathWithinRoot,
  assertPathWithinRoot,
  PathNotFoundError,
  PathOutsideRootError,
} from "./assert-path-within-root.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "libris-path-root-"));
  const outside = await mkdtemp(join(tmpdir(), "libris-path-outside-"));
  cleanup.push(root, outside);
  const file = join(root, "book.epub");
  await writeFile(file, "book");
  return { root, outside, file };
}

describe("assertExistingPathWithinRoot", () => {
  it("accepts an existing file within the root", async () => {
    const { root, file } = await fixture();
    expect(() => assertExistingPathWithinRoot(file, root)).not.toThrow();
  });

  it("rejects a missing file distinctly", async () => {
    const { root } = await fixture();
    expect(() => assertExistingPathWithinRoot(join(root, "missing.epub"), root)).toThrow(
      PathNotFoundError,
    );
  });

  it("rejects an out-of-root path and a relative path", async () => {
    const { root, outside } = await fixture();
    const outsideFile = join(outside, "book.epub");
    await writeFile(outsideFile, "book");

    expect(() => assertExistingPathWithinRoot(outsideFile, root)).toThrow(PathOutsideRootError);
    expect(() => assertExistingPathWithinRoot("book.epub", root)).toThrow(PathOutsideRootError);
  });

  it("rejects a symlink whose target escapes the root", async () => {
    const { root, outside } = await fixture();
    const outsideFile = join(outside, "book.epub");
    const link = join(root, "linked.epub");
    await writeFile(outsideFile, "book");
    await symlink(outsideFile, link);

    expect(() => assertExistingPathWithinRoot(link, root)).toThrow(PathOutsideRootError);
  });
});

describe("assertPathWithinRoot", () => {
  it("maps missing files to 404 and escapes to 403", async () => {
    const { root, outside } = await fixture();
    const outsideFile = join(outside, "book.epub");
    await writeFile(outsideFile, "book");

    expect(() => assertPathWithinRoot(join(root, "missing.epub"), root)).toThrowError(
      expect.objectContaining({ status: 404 }),
    );
    expect(() => assertPathWithinRoot(outsideFile, root)).toThrowError(
      expect.objectContaining({ status: 403 }),
    );
  });
});
