import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";

/**
 * Ownership hangs off `users`, not `apiKeys`: an api key is one of a user's
 * credentials, so the "owner" side of every relation below points at users.
 */
export const relations = defineRelations(schema, (r) => ({
  users: {
    createdBooks: r.many.books({
      from: r.users.id,
      to: r.books.createdBy,
    }),
    apiKeys: r.many.apiKeys({
      from: r.users.id,
      to: r.apiKeys.referenceId,
    }),
    sessions: r.many.sessions({
      from: r.users.id,
      to: r.sessions.userId,
    }),
    accounts: r.many.accounts({
      from: r.users.id,
      to: r.accounts.userId,
    }),
    kosyncCredential: r.one.kosyncCredentials({
      from: r.users.id,
      to: r.kosyncCredentials.userId,
    }),
    serviceCredentials: r.many.serviceCredentials({
      from: r.users.id,
      to: r.serviceCredentials.userId,
    }),
    readingProgress: r.many.readingProgress({
      from: r.users.id,
      to: r.readingProgress.userId,
    }),
    readingProgressHistory: r.many.readingProgressHistory({
      from: r.users.id,
      to: r.readingProgressHistory.userId,
    }),
    uploads: r.many.uploadRegistry({
      from: r.users.id,
      to: r.uploadRegistry.userId,
    }),
    hardcoverSyncLogs: r.many.hardcoverSyncLog({
      from: r.users.id,
      to: r.hardcoverSyncLog.userId,
    }),
  },
  apiKeys: {
    owner: r.one.users({
      from: r.apiKeys.referenceId,
      to: r.users.id,
    }),
  },
  sessions: {
    user: r.one.users({
      from: r.sessions.userId,
      to: r.users.id,
    }),
  },
  accounts: {
    user: r.one.users({
      from: r.accounts.userId,
      to: r.users.id,
    }),
  },
  books: {
    creator: r.one.users({
      from: r.books.createdBy,
      to: r.users.id,
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
    owner: r.one.users({
      from: r.hardcoverSyncLog.userId,
      to: r.users.id,
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
    owner: r.one.users({
      from: r.readingProgress.userId,
      to: r.users.id,
    }),
  },
  readingProgressHistory: {
    book: r.one.books({
      from: r.readingProgressHistory.bookId,
      to: r.books.id,
    }),
    owner: r.one.users({
      from: r.readingProgressHistory.userId,
      to: r.users.id,
    }),
  },
  kosyncCredentials: {
    owner: r.one.users({
      from: r.kosyncCredentials.userId,
      to: r.users.id,
    }),
  },
  serviceCredentials: {
    owner: r.one.users({
      from: r.serviceCredentials.userId,
      to: r.users.id,
    }),
  },
  uploadRegistry: {
    owner: r.one.users({
      from: r.uploadRegistry.userId,
      to: r.users.id,
    }),
  },
}));
