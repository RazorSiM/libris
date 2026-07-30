import type { PGlite } from "@electric-sql/pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vite-plus/test";
import * as schema from "../db/schema";
import { createTestDb, type TestDb } from "../db/test-utils";
import {
  getAppSetting,
  setAppSetting,
  isHardcoverMetadataEnabled,
  isHardcoverSyncEnabled,
} from "./settings";

let pglite: PGlite;
let db: TestDb;

beforeAll(async () => {
  const testDb = await createTestDb();
  pglite = testDb.pglite;
  db = testDb.db;
});

afterAll(async () => {
  await pglite.close();
});

afterEach(async () => {
  await db.delete(schema.appSettings);
});

describe("getAppSetting / setAppSetting", () => {
  it("returns fallback when no setting exists", async () => {
    const value = await getAppSetting(db as any, "nonexistent", "default");
    expect(value).toBe("default");
  });

  it("stores and retrieves a string setting", async () => {
    await setAppSetting(db as any, "test.key", "hello");
    const value = await getAppSetting(db as any, "test.key", "default");
    expect(value).toBe("hello");
  });

  it("stores and retrieves a boolean setting", async () => {
    await setAppSetting(db as any, "feature.enabled", true);
    const value = await getAppSetting(db as any, "feature.enabled", false);
    expect(value).toBe(true);
  });

  it("upserts on conflict (updates existing)", async () => {
    await setAppSetting(db as any, "counter", 1);
    await setAppSetting(db as any, "counter", 2);
    const value = await getAppSetting(db as any, "counter", 0);
    expect(value).toBe(2);
  });

  it("stores and retrieves an object setting", async () => {
    await setAppSetting(db as any, "config", { a: 1, b: "two" });
    const value = await getAppSetting(db as any, "config", {});
    expect(value).toEqual({ a: 1, b: "two" });
  });
});

describe("Hardcover toggle helpers", () => {
  it("defaults metadataEnabled to true when unset", async () => {
    expect(await isHardcoverMetadataEnabled(db as any)).toBe(true);
  });

  it("defaults syncEnabled to true when unset", async () => {
    expect(await isHardcoverSyncEnabled(db as any)).toBe(true);
  });

  it("respects metadataEnabled = false", async () => {
    await setAppSetting(db as any, "hardcover.metadataEnabled", false);
    expect(await isHardcoverMetadataEnabled(db as any)).toBe(false);
  });

  it("respects syncEnabled = false", async () => {
    await setAppSetting(db as any, "hardcover.syncEnabled", false);
    expect(await isHardcoverSyncEnabled(db as any)).toBe(false);
  });

  it("can re-enable after disabling", async () => {
    await setAppSetting(db as any, "hardcover.syncEnabled", false);
    expect(await isHardcoverSyncEnabled(db as any)).toBe(false);

    await setAppSetting(db as any, "hardcover.syncEnabled", true);
    expect(await isHardcoverSyncEnabled(db as any)).toBe(true);
  });
});
