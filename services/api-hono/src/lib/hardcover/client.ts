import { ofetch } from "ofetch";
import { getLogger } from "../logger.js";

// ── Constants ────────────────────────────────────────────────────

export const HARDCOVER_API_URL = "https://api.hardcover.app/v1/graphql";
export const HARDCOVER_RATE_LIMIT = 60; // requests per minute

// ── Error & Result Types ─────────────────────────────────────────

export type HardcoverError =
  | { type: "rate_limited" }
  | { type: "unauthorized" }
  | { type: "api_error"; message: string }
  | { type: "network_error"; cause: unknown };

type Result<T> = { ok: true; data: T } | { ok: false; error: HardcoverError };

// ── Logger ───────────────────────────────────────────────────────

const log = getLogger("hardcover");

// ── GraphQL Helper ───────────────────────────────────────────────

async function graphql<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Result<T>> {
  try {
    const response = await ofetch<{ data?: T; errors?: { message: string }[] }>(HARDCOVER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "libris/1.0",
      },
      body: { query, variables },
      timeout: 10_000,
      redirect: "manual",
    });

    if (response.errors?.length) {
      const message = response.errors[0]!.message;
      log.withMetadata({ message }).error("GraphQL error");
      return { ok: false, error: { type: "api_error", message } };
    }

    return { ok: true, data: response.data as T };
  } catch (error) {
    const status = (error as { status?: number }).status;

    if (status === 429) {
      log.warn("Rate limited (429)");
      return { ok: false, error: { type: "rate_limited" } };
    }

    if (status === 401 || status === 403) {
      log.warn(`Unauthorized (${status})`);
      return { ok: false, error: { type: "unauthorized" } };
    }

    log.withMetadata({ error: String(error) }).error("Network error");
    return { ok: false, error: { type: "network_error", cause: error } };
  }
}

// ── Queries & Mutations ──────────────────────────────────────────

const VERIFY_TOKEN_QUERY = `query { me { id username } }`;

const FIND_EDITION_BY_ISBN_QUERY = `
  query FindEdition($isbn: String!) {
    editions(where: { isbn_13: { _eq: $isbn } }, limit: 1) {
      id
      pages
      book {
        id
        featured_book_series { position series { name } }
        book_series(limit: 1) { position series { name } }
      }
    }
  }
`;

const FIND_EDITION_BY_ISBN10_QUERY = `
  query FindEditionByIsbn10($isbn: String!) {
    editions(where: { isbn_10: { _eq: $isbn } }, limit: 1) {
      id
      pages
      book {
        id
        featured_book_series { position series { name } }
        book_series(limit: 1) { position series { name } }
      }
    }
  }
`;

const GET_EDITION_PAGES_QUERY = `
  query GetEditionPages($id: Int!) {
    editions(where: { id: { _eq: $id } }, limit: 1) {
      id
      pages
    }
  }
`;

const UPSERT_USER_BOOK_MUTATION = `
  mutation UpsertUserBook($object: UserBookCreateInput!) {
    insert_user_book(object: $object) {
      id
      error
    }
  }
`;

const UPSERT_USER_BOOK_READ_MUTATION = `
  mutation UpsertUserBookRead($user_book_id: Int!, $user_book_read: DatesReadInput!) {
    insert_user_book_read(user_book_id: $user_book_id, user_book_read: $user_book_read) {
      id
    }
  }
`;

const UPDATE_USER_BOOK_READ_MUTATION = `
  mutation UpdateUserBookRead($id: Int!, $object: DatesReadInput!) {
    update_user_book_read(id: $id, object: $object) {
      id
    }
  }
`;

const UPDATE_USER_BOOK_MUTATION = `
  mutation UpdateUserBook($id: Int!, $object: UserBookUpdateInput!) {
    update_user_book(id: $id, object: $object) {
      id
    }
  }
`;

const GET_USER_BOOKS_QUERY = `
  query GetUserBooks($limit: Int!, $offset: Int!) {
    me {
      user_books(limit: $limit, offset: $offset) {
        book_id
        status_id
      }
    }
  }
`;

// ── Public API ───────────────────────────────────────────────────

export async function verifyToken(
  token: string,
): Promise<Result<{ id: number; username: string }>> {
  const result = await graphql<{ me: { id: number; username: string }[] }>(
    token,
    VERIFY_TOKEN_QUERY,
  );

  if (!result.ok) return result;

  const me = result.data.me[0];
  if (!me) {
    log.warn("verifyToken: no user returned");
    return { ok: false, error: { type: "unauthorized" } };
  }

  return { ok: true, data: { id: me.id, username: me.username } };
}

export async function getEditionPages(
  token: string,
  editionId: number,
): Promise<Result<number | null>> {
  const result = await graphql<{
    editions: { id: number; pages?: number }[];
  }>(token, GET_EDITION_PAGES_QUERY, { id: editionId });

  if (!result.ok) return result;

  const edition = result.data.editions[0];
  return { ok: true, data: edition?.pages ?? null };
}

interface BookSeries {
  position?: number;
  series: { name: string };
}

interface EditionResult {
  id: number;
  pages?: number;
  book: {
    id: number;
    featured_book_series?: BookSeries;
    book_series?: BookSeries[];
  };
}

export interface FindEditionResult {
  bookId: number;
  editionId: number;
  pages?: number;
  seriesName?: string;
  seriesPosition?: number;
}

function extractSeries(edition: EditionResult): {
  seriesName?: string;
  seriesPosition?: number;
} {
  const featured = edition.book.featured_book_series;
  const fallback = edition.book.book_series?.[0];
  const entry = featured ?? fallback;
  if (!entry?.series?.name) return {};
  return {
    seriesName: entry.series.name,
    seriesPosition: entry.position,
  };
}

export async function findEditionByIsbn(
  token: string,
  isbn13?: string,
  isbn10?: string,
): Promise<Result<FindEditionResult | null>> {
  if (!isbn13 && !isbn10) {
    return { ok: true, data: null };
  }

  // Try ISBN-13 first
  if (isbn13) {
    const result = await graphql<{
      editions: EditionResult[];
    }>(token, FIND_EDITION_BY_ISBN_QUERY, { isbn: isbn13 });

    if (!result.ok) return result;

    const edition = result.data.editions[0];
    if (edition) {
      return {
        ok: true,
        data: {
          bookId: edition.book.id,
          editionId: edition.id,
          pages: edition.pages,
          ...extractSeries(edition),
        },
      };
    }
  }

  // Fallback to ISBN-10
  if (isbn10) {
    const result = await graphql<{
      editions: EditionResult[];
    }>(token, FIND_EDITION_BY_ISBN10_QUERY, { isbn: isbn10 });

    if (!result.ok) return result;

    const edition = result.data.editions[0];
    if (edition) {
      return {
        ok: true,
        data: {
          bookId: edition.book.id,
          editionId: edition.id,
          pages: edition.pages,
          ...extractSeries(edition),
        },
      };
    }
  }

  return { ok: true, data: null };
}

export async function upsertUserBook(
  token: string,
  params: { bookId: number; statusId: number; rating?: number },
): Promise<Result<{ userBookId: number }>> {
  const object: Record<string, unknown> = {
    book_id: params.bookId,
    status_id: params.statusId,
  };
  if (params.rating !== undefined) {
    object["rating"] = params.rating;
  }

  const result = await graphql<{
    insert_user_book: { id: number; error: string | null };
  }>(token, UPSERT_USER_BOOK_MUTATION, { object });

  if (!result.ok) return result;

  const { id, error } = result.data.insert_user_book;
  if (error) {
    log.withMetadata({ error }).error("upsertUserBook inline error");
    return { ok: false, error: { type: "api_error", message: error } };
  }

  return { ok: true, data: { userBookId: id } };
}

export async function upsertUserBookRead(
  token: string,
  params: {
    userBookId: number;
    progressPages?: number;
    editionId?: number;
    startedAt?: string;
    finishedAt?: string;
  },
): Promise<Result<{ readId: number }>> {
  const userBookRead: Record<string, unknown> = {};
  if (params.progressPages !== undefined) {
    userBookRead["progress_pages"] = params.progressPages;
  }
  if (params.editionId !== undefined) {
    userBookRead["edition_id"] = params.editionId;
  }
  if (params.startedAt !== undefined) {
    userBookRead["started_at"] = params.startedAt;
  }
  if (params.finishedAt !== undefined) {
    userBookRead["finished_at"] = params.finishedAt;
  }

  const result = await graphql<{
    insert_user_book_read: { id: number };
  }>(token, UPSERT_USER_BOOK_READ_MUTATION, {
    user_book_id: params.userBookId,
    user_book_read: userBookRead,
  });

  if (!result.ok) return result;

  return { ok: true, data: { readId: result.data.insert_user_book_read.id } };
}

export async function updateUserBookRead(
  token: string,
  params: {
    readId: number;
    progressPages?: number;
    editionId?: number;
    startedAt?: string;
    finishedAt?: string;
  },
): Promise<Result<{ readId: number }>> {
  const object: Record<string, unknown> = {};
  if (params.progressPages !== undefined) {
    object["progress_pages"] = params.progressPages;
  }
  if (params.editionId !== undefined) {
    object["edition_id"] = params.editionId;
  }
  if (params.startedAt !== undefined) {
    object["started_at"] = params.startedAt;
  }
  if (params.finishedAt !== undefined) {
    object["finished_at"] = params.finishedAt;
  }

  const result = await graphql<{
    update_user_book_read: { id: number };
  }>(token, UPDATE_USER_BOOK_READ_MUTATION, {
    id: params.readId,
    object,
  });

  if (!result.ok) return result;

  return { ok: true, data: { readId: result.data.update_user_book_read.id } };
}

export interface HardcoverUserBook {
  bookId: number;
  statusId: number;
}

/**
 * Fetch the authenticated user's full list of user_books with status, paginating
 * 100 entries at a time until the API returns a short page. Used by the
 * Hardcover → Libris pull to backfill `reading_aggregate.external_status`.
 */
export async function getUserBooks(
  token: string,
  options: { pageSize?: number } = {},
): Promise<Result<HardcoverUserBook[]>> {
  const pageSize = options.pageSize ?? 100;
  const all: HardcoverUserBook[] = [];
  let offset = 0;

  while (true) {
    const result = await graphql<{
      me: { user_books: { book_id: number; status_id: number }[] }[];
    }>(token, GET_USER_BOOKS_QUERY, { limit: pageSize, offset });

    if (!result.ok) return result;

    const page = result.data.me[0]?.user_books ?? [];
    for (const row of page) {
      all.push({ bookId: row.book_id, statusId: row.status_id });
    }

    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return { ok: true, data: all };
}

export async function updateRating(
  token: string,
  params: { userBookId: number; rating: number },
): Promise<Result<void>> {
  const result = await graphql<{
    update_user_book: { id: number };
  }>(token, UPDATE_USER_BOOK_MUTATION, {
    id: params.userBookId,
    object: { rating: params.rating },
  });

  if (!result.ok) return result;

  return { ok: true, data: undefined };
}
