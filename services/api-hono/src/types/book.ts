export type BookFormat = "epub";

export type MetadataSource = "hardcover" | "open_library" | "file";

export interface NormalizedMetadata {
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
  series?: string | null;
  seriesIndex?: number | null;
  genres?: string[];
}

export type ApprovedFieldSource = MetadataSource | "manual";

export interface ApprovedField<T = string> {
  source: ApprovedFieldSource;
  value: T;
}

export interface ApproveBookBody {
  fields: {
    title?: ApprovedField;
    author?: ApprovedField;
    isbn10?: ApprovedField;
    isbn13?: ApprovedField;
    publisher?: ApprovedField;
    publishedYear?: ApprovedField<number>;
    language?: ApprovedField;
    description?: ApprovedField;
    coverUrl?: ApprovedField;
    pageCount?: ApprovedField<number>;
    series?: ApprovedField;
    seriesIndex?: ApprovedField<number>;
    genres?: ApprovedField<string[]>;
    tags?: ApprovedField<string[]>;
  };
}

export type ReadingStatus = "unread" | "reading" | "finished" | "paused";

export interface ReadingStatusOverrideBody {
  status: ReadingStatus;
  startedAt?: string | null;
  finishedAt?: string | null;
  pausedAt?: string | null;
}
