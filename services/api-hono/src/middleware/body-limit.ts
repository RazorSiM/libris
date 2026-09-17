import { createMiddleware } from "hono/factory";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../env.js";

/** Maximum request body size in bytes (1 MB) */
const MAX_BODY_SIZE = 1_048_576;

const UPLOAD_PATH_PREFIX = "/api/inbox/upload";

const UPLOAD_TOO_LARGE = "Upload exceeds the configured size limit";

/**
 * Replace a request body with a pass-through that fails once more than
 * `maxBytes` have been read.
 *
 * Buffering the body to measure it moves the exhaustion rather than removing
 * it, which is why the upload path could not reuse `hono/body-limit` with a
 * larger ceiling: that middleware collects every chunk before it decides. This
 * counts as the multipart parser reads, and errors the stream at the cap so
 * nothing downstream keeps consuming.
 */
function boundedUploadBody(raw: Request, maxBytes: number, onExceeded: () => void): Request {
  if (!raw.body) return raw;

  let size = 0;
  const bounded = raw.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > maxBytes) {
          onExceeded();
          controller.error(new Error(UPLOAD_TOO_LARGE));
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  return new Request(raw, { body: bounded, duplex: "half" } as RequestInit);
}

export const bodyLimitMiddleware = createMiddleware(async (c, next) => {
  const env = c.get("env");

  // Uploads get their own aggregate ceiling. The route's per-file check runs
  // after `parseBody` has already buffered the request, so it cannot bound
  // memory; this is the limit the stream enforces. The route's file-count cap
  // reads LIBRIS_MAX_UPLOAD_FILES after parsing.
  if (c.req.path.startsWith(UPLOAD_PATH_PREFIX)) {
    const maxBytes = env.LIBRIS_MAX_UPLOAD_BYTES || DEFAULT_MAX_UPLOAD_BYTES;

    const declared = c.req.header("content-length");
    if (declared !== undefined && Number(declared) > maxBytes) {
      throw new HTTPException(413, { message: UPLOAD_TOO_LARGE });
    }

    let exceeded = false;
    c.req.raw = boundedUploadBody(c.req.raw, maxBytes, () => {
      exceeded = true;
    });

    // Hono's compose turns a thrown error into a response at the handler that
    // threw, so a stream abort reaches this point as a 5xx response, not as an
    // exception. The flag is what turns it back into a 413.
    await next();
    if (exceeded) {
      throw new HTTPException(413, { message: UPLOAD_TOO_LARGE });
    }
    return;
  }

  return bodyLimit({ maxSize: MAX_BODY_SIZE })(c, next);
});
