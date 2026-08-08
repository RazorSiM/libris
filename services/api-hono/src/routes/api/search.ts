import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { and, sql } from "drizzle-orm";
import { books } from "#db";
import type { AppVariables } from "../../context.js";
import { getUserId, isAdmin } from "../../shared/auth.js";

// ── GET /suggest ─────────────────────────────────────────────────

const suggestRoute = createRoute({
  method: "get",
  path: "/suggest",
  tags: ["search"],
  summary: "Search suggestions for command palette",
  description:
    "Lightweight prefix search returning up to 8 results for autocomplete. Matches every organized book (the library is shared) plus the caller's own review books, so you can find an upload of yours that is still awaiting metadata approval. Other users' review books are never returned; admins see all of them.",
  request: {
    query: z.object({
      q: z
        .string()
        .max(500)
        .trim()
        .min(1, "q is required")
        .openapi({ description: "Search prefix" }),
    }),
  },
  responses: {
    200: {
      description: "Search suggestions",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(
              z.object({
                id: z.string().uuid(),
                title: z.string().nullable(),
                author: z.string().nullable(),
                status: z.string(),
                coverUrl: z.string().nullable(),
              }),
            ),
          }),
        },
      },
    },
  },
});

// ── Router ───────────────────────────────────────────────────────

export const searchRoutes = createOpenApiRouter<{ Variables: AppVariables }>().openapi(
  suggestRoute,
  async (c) => {
    const { q } = c.req.valid("query");
    const db = c.get("db");
    const userId = getUserId(c);

    // Sanitize input for tsquery: remove special tsquery characters
    const sanitized = q.replaceAll(/[&|!<>():*\\]/g, " ").trim();
    if (!sanitized) {
      return c.json({ data: [] });
    }

    // Build prefix tsquery: split words, append :* to last word for prefix matching
    const words = sanitized.split(/\s+/).filter(Boolean);
    const tsquery = words
      .map((w: string, i: number) => (i === words.length - 1 ? `${w}:*` : w))
      .join(" & ");

    // Organized books are the shared library and match for everyone. Review
    // books are pre-approval uploads: /api/inbox refuses to list, show or serve
    // the cover of one the caller does not own, so suggest must not hand back
    // their title, author and cover either. Your own still match — that is how
    // you find an upload that is waiting on you.
    const visible = isAdmin(c)
      ? sql`${books.status} IN ('organized', 'review')`
      : sql`(${books.status} = 'organized' OR (${books.status} = 'review' AND ${books.createdBy} = ${userId}))`;

    const results = await db
      .select({
        id: books.id,
        title: books.title,
        author: books.author,
        status: books.status,
        coverUrl: books.coverUrl,
      })
      .from(books)
      .where(and(visible, sql`"search_vector" @@ to_tsquery('english', ${tsquery})`))
      .orderBy(sql`ts_rank("search_vector", to_tsquery('english', ${tsquery})) DESC`)
      .limit(8);

    return c.json({ data: results });
  },
);
