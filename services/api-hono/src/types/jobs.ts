import { z } from "zod";

const BookFormatSchema = z.enum(["epub"]);

export const BookDetectedPayloadSchema = z.object({
  filePath: z.string(),
  detectedAt: z.string(),
});

export const BookParseFilePayloadSchema = z.object({
  bookId: z.string(),
  bookFileId: z.string(),
  filePath: z.string(),
  format: BookFormatSchema,
});

export const BookFetchMetadataPayloadSchema = z.object({
  bookId: z.string(),
  searchQuery: z.string(),
  skipStatusChange: z.boolean().optional(),
});

export const BookOrganizePayloadSchema = z.object({
  bookId: z.string(),
  forceRedownloadCover: z.boolean().optional(),
});

export type BookDetectedPayload = z.infer<typeof BookDetectedPayloadSchema>;
export type BookParseFilePayload = z.infer<typeof BookParseFilePayloadSchema>;
export type BookFetchMetadataPayload = z.infer<typeof BookFetchMetadataPayloadSchema>;
export type BookOrganizePayload = z.infer<typeof BookOrganizePayloadSchema>;
