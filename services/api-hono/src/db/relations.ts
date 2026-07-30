import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

export const relations = defineRelations(schema, (r) => ({
  apiKeys: {
    createdBooks: r.many.books({
      from: r.apiKeys.id,
      to: r.books.createdBy,
    }),
    serviceCredentials: r.many.serviceCredentials({
      from: r.apiKeys.id,
      to: r.serviceCredentials.apiKeyId,
    }),
    readingProgress: r.many.readingProgress({
      from: r.apiKeys.id,
      to: r.readingProgress.apiKeyId,
    }),
    readingProgressHistory: r.many.readingProgressHistory({
      from: r.apiKeys.id,
      to: r.readingProgressHistory.apiKeyId,
    }),
    hardcoverSyncLogs: r.many.hardcoverSyncLog({
      from: r.apiKeys.id,
      to: r.hardcoverSyncLog.apiKeyId,
    }),
  },
  books: {
    creator: r.one.apiKeys({
      from: r.books.createdBy,
      to: r.apiKeys.id,
    }),
    hardcoverSyncLogs: r.many.hardcoverSyncLog({
      from: r.books.id,
      to: r.hardcoverSyncLog.bookId,
    }),
    files: r.many.bookFiles({
      from: r.books.id,
      to: r.bookFiles.bookId,
    }),
    metadataCandidates: r.many.bookMetadataCandidates({
      from: r.books.id,
      to: r.bookMetadataCandidates.bookId,
    }),
  },
  hardcoverSyncLog: {
    book: r.one.books({
      from: r.hardcoverSyncLog.bookId,
      to: r.books.id,
    }),
    apiKey: r.one.apiKeys({
      from: r.hardcoverSyncLog.apiKeyId,
      to: r.apiKeys.id,
    }),
  },
  bookFiles: {
    book: r.one.books({
      from: r.bookFiles.bookId,
      to: r.books.id,
    }),
  },
  bookMetadataCandidates: {
    book: r.one.books({
      from: r.bookMetadataCandidates.bookId,
      to: r.books.id,
    }),
  },
  readingProgress: {
    book: r.one.books({
      from: r.readingProgress.bookId,
      to: r.books.id,
    }),
    apiKey: r.one.apiKeys({
      from: r.readingProgress.apiKeyId,
      to: r.apiKeys.id,
    }),
  },
  readingProgressHistory: {
    book: r.one.books({
      from: r.readingProgressHistory.bookId,
      to: r.books.id,
    }),
    apiKey: r.one.apiKeys({
      from: r.readingProgressHistory.apiKeyId,
      to: r.apiKeys.id,
    }),
  },
  serviceCredentials: {
    apiKey: r.one.apiKeys({
      from: r.serviceCredentials.apiKeyId,
      to: r.apiKeys.id,
    }),
  },
  uploadRegistry: {
    apiKey: r.one.apiKeys({
      from: r.uploadRegistry.apiKeyId,
      to: r.apiKeys.id,
    }),
  },
}));
