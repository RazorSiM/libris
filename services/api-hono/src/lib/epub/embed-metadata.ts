import { Worker } from "node:worker_threads";
import { DEFAULT_EMBED_TIMEOUT_MS, hasAnyMetadata } from "./embed-core.js";
import type { EpubEmbedMetadata } from "./embed-core.js";

export type { EpubEmbedMetadata } from "./embed-core.js";

export interface EmbedEpubMetadataOptions {
  /** Reject OPF documents larger than this. Default 1 MiB. */
  maxOpfBytes?: number;
  /** Kill the worker if it has not finished by then. Default 30 s. */
  timeoutMs?: number;
  /** Override the worker module, for tests. */
  workerUrl?: URL;
}

/**
 * Embed approved metadata into an EPUB file's OPF Dublin Core section.
 * Writes atomically (tmp file + rename). Runs the rewrite — including the
 * synchronous DEFLATE recompression — in a `node:worker_threads` worker so a
 * crafted EPUB cannot stall the HTTP event loop; the job fails this one book
 * rather than the whole process. Non-epub files are silently skipped by the
 * caller.
 */
export async function embedEpubMetadata(
  filePath: string,
  metadata: EpubEmbedMetadata,
  coverImagePath?: string,
  options: EmbedEpubMetadataOptions = {},
): Promise<void> {
  // Skip if no meaningful metadata to embed
  if (!hasAnyMetadata(metadata) && !coverImagePath) return;

  const timeoutMs = options.timeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS;
  const workerUrl = options.workerUrl ?? defaultWorkerUrl();

  const worker = new Worker(workerUrl, {
    workerData: {
      filePath,
      metadata,
      coverImagePath,
      maxOpfBytes: options.maxOpfBytes,
    },
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      complete();
    };

    const timer = setTimeout(() => {
      finish(() => reject(new Error(`EPUB metadata embedding timed out after ${timeoutMs}ms`)));
    }, timeoutMs);

    worker.once("message", (message: { ok: boolean; error?: string }) => {
      finish(() => {
        if (message.ok) resolve();
        else reject(new Error(message.error || "EPUB metadata embedding failed in worker"));
      });
    });
    worker.once("error", (error) => {
      finish(() => reject(error));
    });
    worker.once("exit", (code) => {
      finish(() => {
        reject(new Error(`EPUB metadata worker exited with code ${code} before responding`));
      });
    });
  });
}

/**
 * The worker lives next to this module. Sources are `.ts` (tsx in dev, native
 * type stripping in vitest); the published build emits a sibling
 * `embed-worker.mjs` next to `index.mjs`, so the same relative URL works.
 */
function defaultWorkerUrl(): URL {
  const workerFile = import.meta.url.endsWith(".ts") ? "./embed-worker.ts" : "./embed-worker.mjs";
  return new URL(workerFile, import.meta.url);
}
