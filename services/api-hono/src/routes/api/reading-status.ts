import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import type { AppVariables } from "../../context.js";
import { getReadingStatusCounts, getBooksByReadingStatus } from "../../lib/reading-status.js";
import { getApiKeyId } from "../../shared/auth.js";
import { ReadingStatusParamSchema, ReadingStatusListQuerySchema } from "../../shared/validation.js";
import {
  ReadingStatusCountsSchema,
  ReadingStatusListResponseSchema,
} from "../../shared/schemas.js";

// ── GET /counts ──────────────────────────────────────────────────

const countsRoute = createRoute({
  method: "get",
  path: "/counts",
  tags: ["reading-status"],
  summary: "Get reading status counts",
  description:
    "Returns the count of organized books in each reading status (unread, reading, finished, paused).",
  responses: {
    200: {
      description: "Status counts",
      content: {
        "application/json": {
          schema: ReadingStatusCountsSchema,
        },
      },
    },
  },
});

// ── GET /{status} ────────────────────────────────────────────────

const listByStatusRoute = createRoute({
  method: "get",
  path: "/{status}",
  tags: ["reading-status"],
  summary: "List books by reading status",
  description:
    "Returns a paginated list of organized books filtered by the given reading status, with optional search and sorting.",
  request: {
    params: ReadingStatusParamSchema,
    query: ReadingStatusListQuerySchema,
  },
  responses: {
    200: {
      description: "Paginated list of books with reading progress",
      content: {
        "application/json": {
          schema: ReadingStatusListResponseSchema,
        },
      },
    },
    422: { description: "Invalid status parameter" },
  },
});

// ── Router ───────────────────────────────────────────────────────

export const readingStatusRoutes = new OpenAPIHono<{ Variables: AppVariables }>()
  .openapi(countsRoute, async (c) => {
    const db = c.get("db");
    const apiKeyId = getApiKeyId(c);
    const counts = await getReadingStatusCounts(db, apiKeyId);
    return c.json(counts);
  })
  .openapi(listByStatusRoute, async (c) => {
    const { status } = c.req.valid("param");
    const { page, limit, sort, order, search } = c.req.valid("query");

    const db = c.get("db");
    const apiKeyId = getApiKeyId(c);
    const result = await getBooksByReadingStatus(db, status, {
      page,
      perPage: limit,
      sort,
      order,
      search: search || undefined,
      apiKeyId,
    });

    const totalPages = Math.ceil(result.total / limit) || 1;

    return c.json({
      data: result.books,
      pagination: {
        page,
        limit,
        total: result.total,
        totalPages,
      },
    });
  });
