import { createDb, type Db } from "#db";
import { getEnv } from "../env.js";

let _db: Db | undefined;

export function getDb(): Db {
  if (!_db) {
    _db = createDb(getEnv().DATABASE_URL);
  }
  return _db;
}

export function __setTestDb(db: Db): void {
  _db = db;
}
