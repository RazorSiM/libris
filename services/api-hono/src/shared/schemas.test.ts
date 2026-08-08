import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { bookColumns } from "#db";
import { BookUpdatedSchema } from "./schemas.js";

/**
 * The response must be the shape the route says it is.
 *
 * `PATCH /api/library/{id}` and `POST /api/library/{id}/apply-metadata` both
 * declare `BookUpdatedSchema` and both fulfilled it with
 * `db.update(...).returning()` — the argument-less form, which returns EVERY
 * column of `books`. That includes `search_vector`, the internal tsvector the
 * schema deliberately omits: a lexeme dump of the title, author, series and
 * description, shipped to the client on every metadata edit, described by
 * nothing in the OpenAPI document.
 */
describe("BookUpdatedSchema matches the columns the query returns", () => {
  it("declares exactly the columns of `bookColumns`", () => {
    // The anti-drift bolt. Both sides are derived from the `books` table:
    // `bookColumns` is `getColumns(books)` minus searchVector, BookUpdatedSchema
    // is `BookSelectSchema` minus searchVector. Passing `bookColumns` to
    // `.returning()` is what makes the response literally this schema's shape,
    // so adding a column to the table extends both at once, and dropping one
    // narrows both at once. Should they ever be allowed to disagree again, this
    // is where it shows up.
    expect(Object.keys(BookUpdatedSchema.shape).sort()).toEqual(Object.keys(bookColumns).sort());
  });

  it("omits search_vector on both sides", () => {
    // Pinned separately from the equality above: two lists that agree on
    // containing searchVector would still satisfy that test.
    expect(Object.keys(BookUpdatedSchema.shape)).not.toContain("searchVector");
    expect(Object.keys(bookColumns)).not.toContain("searchVector");
  });
});

/**
 * The class of bug, not the instance.
 *
 * Fixing the two call sites leaves the next `.returning()` free to reintroduce
 * the leak, and it would pass review — `.returning()` reads as "return the
 * updated row", not "return the row plus every internal column we have ever
 * added to this table". So no route may use the argument-less form at all: the
 * column list has to be written down where the reviewer reading the handler can
 * compare it against the schema three lines above.
 */
describe("no route fulfils a response with a bare .returning()", () => {
  const routesDir = fileURLToPath(new URL("../routes/", import.meta.url));

  /** `.returning()` with no column list — returns every column of the table. */
  const BARE_RETURNING = /\.returning\(\s*\)/;

  function listSourceFiles(dir: string): string[] {
    return readdirSync(dir, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
      .map((entry) => entry.split(sep).join("/"));
  }

  function stripComments(source: string): string {
    return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/^\s*\/\/.*$/gm, "");
  }

  it("finds route sources to check", () => {
    // Guards the assertion below against passing vacuously.
    expect(listSourceFiles(routesDir).length).toBeGreaterThan(5);
  });

  it("names the columns it returns, everywhere", () => {
    const offenders = listSourceFiles(routesDir).filter((file) =>
      BARE_RETURNING.test(stripComments(readFileSync(join(routesDir, file), "utf8"))),
    );

    expect(offenders).toEqual([]);
  });
});
