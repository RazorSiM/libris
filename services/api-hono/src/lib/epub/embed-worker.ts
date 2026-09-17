import { parentPort, workerData } from "node:worker_threads";
import { embedEpubMetadataInProcess } from "./embed-core.ts";
import type { EpubEmbedMetadata } from "./embed-core.ts";

interface EmbedWorkerData {
  filePath: string;
  metadata: EpubEmbedMetadata;
  coverImagePath?: string;
  maxOpfBytes?: number;
}

const data = workerData as EmbedWorkerData;

try {
  await embedEpubMetadataInProcess(data.filePath, data.metadata, {
    coverImagePath: data.coverImagePath,
    maxOpfBytes: data.maxOpfBytes,
  });
  parentPort?.postMessage({ ok: true });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
