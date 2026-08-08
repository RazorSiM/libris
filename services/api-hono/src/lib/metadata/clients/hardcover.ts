import { ofetch } from "ofetch";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { serviceCredentials } from "#db";
import type {
  MetadataCandidate,
  MetadataSearchQuery,
  NormalizedMetadata,
} from "../../../types/index.js";
import { isValidIsbn, sanitizeMetadata } from "../sanitize.js";
import { unsealToken } from "../../../shared/auth.js";
import { getDb } from "../../../services/db.js";
import { getEnv } from "../../../env.js";
import { isHardcoverMetadataEnabled } from "../../../services/settings.js";

import { getLogger } from "../../logger.js";

const logger = getLogger("metadata:hardcover");

const HARDCOVER_API_URL = "https://api.hardcover.app/v1/graphql";

// Search returns flat Typesense documents — request only `results` as raw JSON
const SEARCH_QUERY = `
  query SearchBooks($query: String!) {
    search(query: $query, query_type: "Book", per_page: 5) {
      results
    }
  }
`;

// Typesense search hit document — flat fields, not nested GraphQL objects
const HardcoverDocSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string().optional(),
  slug: z.string().optional(),
  release_year: z.number().optional(),
  pages: z.number().optional(),
  description: z.string().optional(),
  image: z.object({ url: z.string().optional() }).optional().or(z.string().optional()),
  isbns: z.array(z.string()).optional(),
  author_names: z.array(z.string()).optional(),
  genres: z.array(z.string()).optional(),
  series_names: z.array(z.string()).optional(),
});

const HardcoverResponseSchema = z.object({
  data: z.object({
    search: z.object({
      results: z.object({
        hits: z.array(z.object({ document: z.record(z.string(), z.unknown()) })),
      }),
    }),
  }),
});

type HardcoverDoc = z.infer<typeof HardcoverDocSchema>;

function normalize(doc: HardcoverDoc): NormalizedMetadata {
  const imageUrl = typeof doc.image === "object" ? doc.image?.url : doc.image;
  const coverUrl = imageUrl?.startsWith("http") ? imageUrl : undefined;
  const isbn10 = doc.isbns?.find((i) => i.length === 10);
  const isbn13 = doc.isbns?.find((i) => i.length === 13);

  return sanitizeMetadata({
    title: doc.title,
    author: doc.author_names?.[0],
    isbn10,
    isbn13,
    publishedYear: doc.release_year,
    description: doc.description,
    coverUrl,
    pageCount: doc.pages,
    series: doc.series_names?.[0],
    genres: doc.genres ?? ([] as string[]),
  });
}

/**
 * The first Hardcover token on the install, belonging to whoever happens to hold
 * it.
 *
 * Only background jobs may fall back to this: a scheduled enrichment run has no
 * caller to bill, and the alternative is that automatic metadata lookup stops
 * working for every book not uploaded by the token holder. Request paths must
 * pass the caller's own token instead — see `options.token` below.
 */
async function getAnyHardcoverToken(): Promise<string | null> {
  const db = getDb();
  const [cred] = await db
    .select({ passwordHash: serviceCredentials.passwordHash })
    .from(serviceCredentials)
    .where(eq(serviceCredentials.service, "hardcover"))
    .limit(1);
  if (!cred) return null;
  return unsealToken(cred.passwordHash, getEnv().API_SECRET_KEY);
}

/** Decrypt the Hardcover token belonging to one specific user, if they have one. */
export async function getHardcoverTokenForUser(userId: string): Promise<string | null> {
  const db = getDb();
  const [cred] = await db
    .select({ passwordHash: serviceCredentials.passwordHash })
    .from(serviceCredentials)
    .where(and(eq(serviceCredentials.service, "hardcover"), eq(serviceCredentials.userId, userId)))
    .limit(1);
  if (!cred) return null;
  return unsealToken(cred.passwordHash, getEnv().API_SECRET_KEY);
}

export interface SearchHardcoverOptions {
  /**
   * Token to spend on this search. Request paths MUST pass the caller's own
   * token, so nobody's search is billed to and rate-limited against another
   * user's Hardcover account. Omitting it falls back to any token on the
   * install and is only appropriate for background jobs.
   */
  token?: string;
}

export async function searchHardcover(
  query: MetadataSearchQuery,
  options: SearchHardcoverOptions = {},
): Promise<MetadataCandidate[]> {
  const isbn = query.isbn && isValidIsbn(query.isbn) ? query.isbn : null;
  const searchTerm = [query.title, query.author].filter(Boolean).join(" ");
  if (!searchTerm && !isbn) return [];

  const db = getDb();
  const metadataEnabled = await isHardcoverMetadataEnabled(db);
  if (!metadataEnabled) {
    logger.info("Hardcover metadata search disabled, skipping");
    return [];
  }

  const token = options.token ?? (await getAnyHardcoverToken());
  if (!token) {
    logger.info("No Hardcover token configured, skipping search");
    return [];
  }

  // ISBN alone is the strongest identifier,
  // fall back to title+author only when no valid ISBN is available.
  const q = isbn ?? searchTerm;

  try {
    const raw = await ofetch(HARDCOVER_API_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: {
        query: SEARCH_QUERY,
        variables: { query: q },
      },
      timeout: 10_000,
      redirect: "manual",
    });

    // GraphQL APIs return errors in the response body, not as HTTP errors
    const gqlErrors = (raw as Record<string, unknown>)?.errors;
    if (gqlErrors) {
      logger.withMetadata({ errors: gqlErrors, query: q }).warn("Hardcover GraphQL errors");
      return [];
    }

    const parsed = HardcoverResponseSchema.safeParse(raw);
    if (!parsed.success) {
      logger
        .withMetadata({
          error: parsed.error.message,
          raw: JSON.stringify(raw).slice(0, 500),
          query: q,
        })
        .warn("Hardcover response schema mismatch");
      return [];
    }

    const hits = parsed.data.data.search.results.hits;
    logger.withMetadata({ query: q }).info(`Hardcover search returned ${hits.length} hit(s)`);

    return hits.reduce<MetadataCandidate[]>((acc, hit, index) => {
      const docParsed = HardcoverDocSchema.safeParse(hit.document);
      if (!docParsed.success) {
        logger
          .withMetadata({
            error: docParsed.error.message,
            keys: Object.keys(hit.document).join(", "),
          })
          .warn("Hardcover document parse failed");
        return acc;
      }
      acc.push({
        source: "hardcover" as const,
        normalized: normalize(docParsed.data),
        rawResponse: hit.document,
        confidence: index === 0 ? 0.88 : 0.68,
      });
      return acc;
    }, []);
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (status === 429) {
      logger.withMetadata({ query: q }).warn("Hardcover rate limited (429)");
    } else {
      logger.withMetadata({ query: q, error: String(error) }).error("Hardcover search failed");
    }
    return [];
  }
}
