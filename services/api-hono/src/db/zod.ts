import { createInsertSchema, createSelectSchema, createUpdateSchema } from "drizzle-orm/zod";
import { z } from "zod";
import {
  apiKeys,
  bookFiles,
  bookMetadataCandidates,
  books,
  hardcoverSyncLog,
  readingProgress,
} from "./schema";

// --- books ---
export const BookSelectSchema = createSelectSchema(books);
export const BookInsertSchema = createInsertSchema(books);
export const BookUpdateSchema = createUpdateSchema(books);

// --- book_files ---
export const BookFileSelectSchema = createSelectSchema(bookFiles);
export const BookFileInsertSchema = createInsertSchema(bookFiles);
export const BookFileUpdateSchema = createUpdateSchema(bookFiles);

// --- book_metadata_candidates ---
export const BookMetadataCandidateSelectSchema = createSelectSchema(bookMetadataCandidates);
export const BookMetadataCandidateInsertSchema = createInsertSchema(bookMetadataCandidates);
export const BookMetadataCandidateUpdateSchema = createUpdateSchema(bookMetadataCandidates);

// --- reading_progress ---
export const ReadingProgressSelectSchema = createSelectSchema(readingProgress);
export const ReadingProgressInsertSchema = createInsertSchema(readingProgress);
export const ReadingProgressUpdateSchema = createUpdateSchema(readingProgress);

// --- api_keys ---
export const ApiKeySelectSchema = createSelectSchema(apiKeys);
export const ApiKeyInsertSchema = createInsertSchema(apiKeys);
export const ApiKeyUpdateSchema = createUpdateSchema(apiKeys);

// --- hardcover_sync_log ---
export const HardcoverSyncLogSelectSchema = createSelectSchema(hardcoverSyncLog);
export const HardcoverSyncLogInsertSchema = createInsertSchema(hardcoverSyncLog);
export const HardcoverSyncLogUpdateSchema = createUpdateSchema(hardcoverSyncLog);

// --- Inferred types from Zod schemas ---
export type Book = z.infer<typeof BookSelectSchema>;
export type BookInsert = z.infer<typeof BookInsertSchema>;
export type BookFile = z.infer<typeof BookFileSelectSchema>;
export type BookFileInsert = z.infer<typeof BookFileInsertSchema>;
export type BookMetadataCandidate = z.infer<typeof BookMetadataCandidateSelectSchema>;
export type ApiKey = z.infer<typeof ApiKeySelectSchema>;
export type ReadingProgress = z.infer<typeof ReadingProgressSelectSchema>;
export type HardcoverSyncLog = z.infer<typeof HardcoverSyncLogSelectSchema>;
