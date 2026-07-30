// Types shared between MetadataFieldPicker.vue and its tests. Extracted out
// of the SFC because tsgolint (oxlint's type-checker) can't resolve types
// declared inside a .vue file when they're imported from a .ts file —
// types meant to cross the SFC boundary must live in a regular .ts module.
import type { MetadataSource, ApprovedFieldSource } from "@libris/api-hono/types";

export interface CandidateNormalized {
  title?: string | null;
  author?: string | null;
  isbn10?: string | null;
  isbn13?: string | null;
  publisher?: string | null;
  publishedYear?: number | null;
  language?: string | null;
  description?: string | null;
  coverUrl?: string | null;
  pageCount?: number | null;
  genres?: string[];
  series?: string | null;
  seriesIndex?: number | null;
}

export interface Candidate {
  id: string;
  source: MetadataSource;
  normalized: CandidateNormalized;
  confidence: string;
}

export interface FieldSelection {
  source: ApprovedFieldSource;
  value: unknown;
}
