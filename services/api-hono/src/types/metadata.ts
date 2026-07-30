import type { NormalizedMetadata, MetadataSource } from "./book.js";

export interface MetadataCandidate {
  source: MetadataSource;
  normalized: NormalizedMetadata;
  rawResponse: unknown;
  confidence: number;
}

export interface MetadataSearchQuery {
  title?: string;
  author?: string;
  isbn?: string;
}
