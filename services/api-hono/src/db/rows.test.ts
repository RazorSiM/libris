import { describe, expect, it } from "vite-plus/test";
import { rowCount, rowsOf } from "./rows";

/**
 * Both real shapes, plus the cases that made the three private copies of this
 * differ from each other: stats.ts's version threw on a non-iterable object,
 * progress-linking.ts's returned 0, and reading-status.ts had none at all.
 */
describe("rowsOf", () => {
  it("passes through the postgres-js shape (an array-like RowList)", () => {
    // postgres-js resolves db.execute() to a RowList: a real Array subclass
    // carrying `count`/`command` alongside the rows.
    const rowList = Object.assign([{ n: 1 }, { n: 2 }], { count: 2, command: "SELECT" });
    const rows = rowsOf<{ n: number }>(rowList);
    // Handed back as-is: the production driver's result already IS the row
    // array, so normalising it must not cost a copy.
    expect(rows).toBe(rowList as unknown as { n: number }[]);
    expect([...rows]).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("unwraps the PGlite shape ({ rows })", () => {
    const results = { rows: [{ n: 1 }], fields: [], affectedRows: 0 };
    expect(rowsOf<{ n: number }>(results)).toEqual([{ n: 1 }]);
  });

  it("drains a plain iterable", () => {
    expect(rowsOf<number>(new Set([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it("returns empty for a result with no rows to offer", () => {
    // A driver that answers with a bare status object must not throw here —
    // "no rows" is an answer, and this is the branch stats.ts's copy got wrong
    // by falling through to Array.from() on a non-iterable.
    expect(rowsOf({ command: "UPDATE", affectedRows: 3 })).toEqual([]);
    expect(rowsOf(undefined)).toEqual([]);
    expect(rowsOf(null)).toEqual([]);
  });
});

describe("rowCount", () => {
  it("counts both driver shapes the same way", () => {
    expect(rowCount([{ id: "a" }, { id: "b" }])).toBe(2);
    expect(rowCount({ rows: [{ id: "a" }] })).toBe(1);
    expect(rowCount({ rows: [] })).toBe(0);
    expect(rowCount(undefined)).toBe(0);
  });
});
