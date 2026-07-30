import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, and } from "drizzle-orm";
import { createReadStream, existsSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { assertPathWithinRoot } from "../../lib/assert-path-within-root.js";
import { Readable } from "node:stream";
import { HTTPException } from "hono/http-exception";
import { books, bookFiles } from "#db";
import type { AppVariables } from "../../context.js";
import { formatMime } from "../../shared/opds-helpers.js";

// ── Route definitions ───────────────────────────────────────────────

const downloadRoute = createRoute({
  method: "get",
  path: "/{fileId}",
  tags: ["opds"],
  summary: "Download a book file (OPDS)",
  description:
    "Streams an ebook file for download, identified by its file ID. The file must belong to an organized book. Sets Content-Disposition for browser/e-reader download with the original filename.",
  request: {
    params: z.object({
      fileId: z.string().uuid().openapi({
        description: "Book file UUID",
        example: "550e8400-e29b-41d4-a716-446655440000",
      }),
    }),
  },
  responses: {
    200: {
      description: "Ebook file binary stream",
      content: {
        "application/epub+zip": {
          schema: z.any().openapi({ type: "string", format: "binary" }),
        },
        "application/octet-stream": {
          schema: z.any().openapi({ type: "string", format: "binary" }),
        },
      },
    },
    400: { description: "Invalid file ID" },
    404: { description: "File not found or not available for download" },
  },
});

// ── Handlers ────────────────────────────────────────────────────────

export const opdsDownloadRoutes = new OpenAPIHono<{ Variables: AppVariables }>().openapi(
  downloadRoute,
  async (c) => {
    const { fileId } = c.req.valid("param");

    const db = c.get("db");
    const env = c.get("env");

    // Find the file and verify its book is organized
    const [row] = await db
      .select({
        id: bookFiles.id,
        format: bookFiles.format,
        storagePath: bookFiles.storagePath,
        originalName: bookFiles.originalName,
        bookStatus: books.status,
      })
      .from(bookFiles)
      .innerJoin(books, eq(bookFiles.bookId, books.id))
      .where(and(eq(bookFiles.id, fileId), eq(books.status, "organized")));

    if (!row) {
      throw new HTTPException(404, { message: "File not found" });
    }

    if (!row.storagePath) {
      throw new HTTPException(404, { message: "File not available for download" });
    }

    let libraryRoot: string;
    try {
      libraryRoot = realpathSync(env.LIBRIS_LIBRARY_PATH);
    } catch {
      throw new HTTPException(404, { message: "File not found on disk" });
    }
    const fullPath = resolve(join(libraryRoot, row.storagePath));

    assertPathWithinRoot(fullPath, libraryRoot);

    if (!existsSync(fullPath)) {
      throw new HTTPException(404, { message: "File not found on disk" });
    }

    const fileStat = await stat(fullPath);
    const contentType = formatMime(row.format);
    const fileName = row.originalName || basename(fullPath);

    const encodedFileName = encodeURIComponent(fileName)
      .replace(/'/g, "%27")
      .replace(/\(/g, "%28")
      .replace(/\)/g, "%29");

    const stream = Readable.toWeb(createReadStream(fullPath)) as ReadableStream;
    return new Response(stream, {
      headers: {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        "Content-Length": String(fileStat.size),
        "Content-Disposition": `attachment; filename="${encodedFileName}"; filename*=UTF-8''${encodedFileName}`,
      },
    });
  },
);
