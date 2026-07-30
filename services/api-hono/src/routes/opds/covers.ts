import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";
import { createReadStream, existsSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, extname, resolve } from "node:path";
import { assertPathWithinRoot } from "../../lib/assert-path-within-root.js";
import { Readable } from "node:stream";
import { HTTPException } from "hono/http-exception";
import { books } from "#db";
import type { AppVariables } from "../../context.js";

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

// ── Route definitions ───────────────────────────────────────────────

const coverRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["opds"],
  summary: "Get book cover image (OPDS)",
  description:
    "Returns the cover image for an organized book. Used by OPDS clients to display book thumbnails. Supports ETag-based cache revalidation.",
  request: {
    params: z.object({
      id: z
        .string()
        .uuid()
        .openapi({ description: "Book UUID", example: "550e8400-e29b-41d4-a716-446655440000" }),
    }),
  },
  responses: {
    200: {
      description: "Cover image (JPEG, PNG, WebP, or GIF)",
      content: {
        "image/jpeg": { schema: z.any().openapi({ type: "string", format: "binary" }) },
        "image/png": { schema: z.any().openapi({ type: "string", format: "binary" }) },
        "image/webp": { schema: z.any().openapi({ type: "string", format: "binary" }) },
        "image/gif": { schema: z.any().openapi({ type: "string", format: "binary" }) },
      },
    },
    304: { description: "Not modified (ETag matched)" },
    400: { description: "Invalid book ID" },
    404: { description: "Book not found or no cover available" },
  },
});

// ── Handlers ────────────────────────────────────────────────────────

export const opdsCoversRoutes = new OpenAPIHono<{ Variables: AppVariables }>().openapi(
  coverRoute,
  async (c) => {
    const { id } = c.req.valid("param");

    const db = c.get("db");
    const env = c.get("env");

    const [book] = await db
      .select({ coverPath: books.coverPath })
      .from(books)
      .where(and(eq(books.id, id), eq(books.status, "organized")));

    if (!book) {
      throw new HTTPException(404, { message: "Book not found" });
    }

    if (!book.coverPath) {
      throw new HTTPException(404, { message: "No cover image available" });
    }

    const libraryRoot = realpathSync(env.LIBRIS_LIBRARY_PATH);
    const fullPath = resolve(join(libraryRoot, book.coverPath));

    assertPathWithinRoot(fullPath, libraryRoot);

    if (!existsSync(fullPath)) {
      throw new HTTPException(404, { message: "Cover file not found on disk" });
    }

    const fileStat = await stat(fullPath);
    const ext = extname(fullPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    // ETag based on mtime + size for cache revalidation when covers change
    const etag = `W/"${fileStat.mtimeMs.toString(36)}-${fileStat.size.toString(36)}"`;
    if (c.req.header("if-none-match") === etag) {
      return c.body(null, 304);
    }

    const stream = Readable.toWeb(createReadStream(fullPath)) as ReadableStream;
    return new Response(stream, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(fileStat.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "public, max-age=86400",
        ETag: etag,
      },
    });
  },
);
