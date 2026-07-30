import { eq } from "drizzle-orm";
import { appSettings } from "#db";
import type { Db } from "#db";

/** Read a single setting. Returns the parsed JSON value, or `fallback` when unset. */
export async function getAppSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, key))
    .limit(1);
  return row ? (row.value as T) : fallback;
}

/** Write a single setting (upsert). */
export async function setAppSetting<T>(db: Db, key: string, value: T): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    });
}

// --- Hardcover-specific helpers ---

export async function isHardcoverMetadataEnabled(db: Db): Promise<boolean> {
  return getAppSetting(db, "hardcover.metadataEnabled", true);
}

export async function isHardcoverSyncEnabled(db: Db): Promise<boolean> {
  return getAppSetting(db, "hardcover.syncEnabled", true);
}
