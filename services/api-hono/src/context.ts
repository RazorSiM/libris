import type { Db } from "#db";
import type { Env } from "./env.js";
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
  apiKeyId: string | undefined;
  apiKeyLabel: string | undefined;
  isAdmin: boolean;
  db: Db;
  queues: Queues;
  env: Env;
  redisStorage: KVStore;
  cacheStorage: KVStore;
};
