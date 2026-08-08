import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDestinationDirectory, sanitizeName } from "./book-organize.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("sanitizeName", () => {
  it.each([".", "..", "CON", "prn", "LPT1", "name. "])(
    "turns the unsafe component %j into a safe component",
    (name) => {
      const sanitized = sanitizeName(name);
      expect(sanitized).not.toBe("");
      expect(sanitized).not.toMatch(/^(?:\.{1,2}|con|prn|aux|nul|com[1-9]|lpt[1-9])$/i);
      expect(sanitized).not.toMatch(/[. ]$/);
    },
  );
});

describe("createDestinationDirectory", () => {
  it("keeps a dot-dot title inside a normal author/title directory", async () => {
    const library = await mkdtemp(join(tmpdir(), "libris-organize-library-"));
    cleanup.push(library);
    const destination = join(library, sanitizeName("Author"), sanitizeName(".."));

    await createDestinationDirectory(library, destination);

    // `destination` is built with join(library, ...) a few lines up, so
    // asserting it starts with `library` was a tautology (libris-59m.31). What
    // matters is where the directory RESOLVED to on disk once ".." was
    // sanitized — a real ".." would have escaped into the library's parent.
    expect((await stat(destination)).isDirectory()).toBe(true);
    const resolved = await realpath(destination);
    expect(resolved.startsWith(`${await realpath(library)}/`)).toBe(true);
  });

  it("validates the destination before creating it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "libris-organize-parent-"));
    cleanup.push(parent);
    const library = join(parent, "library");
    const escaped = join(parent, "escaped");

    await expect(createDestinationDirectory(library, escaped)).rejects.toThrow(/escapes library/i);
    await expect(
      import("node:fs/promises").then(({ stat }) => stat(escaped)),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
