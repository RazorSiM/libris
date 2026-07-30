import { extname } from "node:path";
import { watch } from "chokidar";
import { getLogger } from "../lib/logger.js";

const logger = getLogger("watcher:plugin");

export const SUPPORTED_EXTENSIONS = new Set([".epub"]);

export interface BookDetectedQueue {
  add(name: string, data: { filePath: string; detectedAt: string }): Promise<unknown>;
}

export interface InboxWatcher {
  close(): Promise<void>;
}

export function createInboxWatcher(inboxPath: string, queue: BookDetectedQueue): InboxWatcher {
  logger.info(`Watching inbox: ${inboxPath}`);

  const watcher = watch(inboxPath, {
    ignoreInitial: false,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100,
    },
  });

  watcher.on("add", async (filePath: string) => {
    const ext = extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      logger.debug(`Ignoring non-book file: ${filePath}`);
      return;
    }

    logger.info(`Book file detected: ${filePath}`);
    try {
      await queue.add("book-detected", {
        filePath,
        detectedAt: new Date().toISOString(),
      });
      logger.info(`Enqueued BOOK_DETECTED for: ${filePath}`);
    } catch (err) {
      logger
        .withMetadata({ error: String(err) })
        .error(`Failed to enqueue BOOK_DETECTED for ${filePath}`);
    }
  });

  watcher.on("error", (err: unknown) => {
    logger.withMetadata({ error: String(err) }).error("Chokidar error");
  });

  return {
    async close() {
      logger.info("Shutting down file watcher...");
      await watcher.close();
      logger.info("Watcher stopped");
    },
  };
}
