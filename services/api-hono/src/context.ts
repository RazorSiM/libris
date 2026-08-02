import type { Db } from "#db";
import type { Env } from "./env.js";
import type { Auth } from "./lib/auth.js";
import type {
  BookDetectedPayload,
  BookParseFilePayload,
  BookFetchMetadataPayload,
  BookOrganizePayload,
} from "./types/index.js";
import type { JobsOptions } from "bullmq";
import type { KVStore } from "./services/kv-store.js";
import type { HonoLogLayerVariables } from "@loglayer/hono";

interface TypedQueue<TPayload> {
  add(name: string, data: TPayload, opts?: JobsOptions): Promise<unknown>;
}

export interface Queues {
  bookDetected: TypedQueue<BookDetectedPayload>;
  bookParseFile: TypedQueue<BookParseFilePayload>;
  bookFetchMetadata: TypedQueue<BookFetchMetadataPayload>;
  bookOrganize: TypedQueue<BookOrganizePayload>;
  close: () => Promise<void>;
}

export type AppVariables = HonoLogLayerVariables & {
  /** The authenticated person. Set from the Better Auth session, or undefined. */
  userId: string | undefined;
  /** Display name, for logs and responses. */
  userName: string | undefined;
  /**
   * Admin plugin role — "admin" or "user", undefined when anonymous.
   *
   * The single source of truth for privilege. There is deliberately no derived
   * `isAdmin` boolean beside it: two variables holding the same fact can drift,
   * and a route that set one without the other would be a silent privilege bug.
   * Use isAdmin(c) from shared/auth.ts to read it.
   */
  role: string | undefined;
  auth: Auth;
  db: Db;
  queues: Queues;
  env: Env;
  redisStorage: KVStore;
  cacheStorage: KVStore;
};
