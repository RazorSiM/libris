import { OpenAPIHono } from "@hono/zod-openapi";
import type { Context, Env as HonoEnv } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getLogger } from "../lib/logger.js";

/**
 * How this API reports failures — in one place, for every router.
 *
 * Two things live here because both are "the error contract", and both used to
 * sit on the root app where most routes could never see them:
 *
 *  - `createOpenApiRouter`, the only way a router should be built. It installs
 *    the validation hook. @hono/zod-openapi resolves a route's hook at
 *    `.openapi()` call time from the instance the route is defined on, and it
 *    propagates `defaultHook` only to sub-apps it creates itself. A route file
 *    that builds its own `new OpenAPIHono()` at import time therefore never
 *    saw the root app's hook and answered validation failures with a raw
 *    serialized ZodError. app.wiring.test.ts fails if any router skips this.
 *
 *  - `toErrorResponse`, the mapping app.ts's `onError` applies. Besides hono's
 *    own HTTPException it has to understand better-call's `APIError`, which is
 *    what every `auth.api.*` call throws. That class extends plain Error, so
 *    without this every Better Auth rejection — an over-long app password
 *    label, say — surfaced to the caller as a 500 with an unhandled-error log.
 */

export interface CreateOpenApiRouterOptions {
  /** Hono's trailing-slash strictness. Only the root app sets this. */
  strict?: boolean;
}

/**
 * Build a router that reports validation failures the documented way:
 * `400 {"error":"Validation failed","issues":[...]}`.
 *
 * Use this instead of `new OpenAPIHono()` anywhere under `src/routes/`.
 */
export function createOpenApiRouter<E extends HonoEnv>(
  init: CreateOpenApiRouterOptions = {},
): OpenAPIHono<E> {
  return new OpenAPIHono<E>({
    ...init,
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: "Validation failed", issues: result.error.issues }, 400);
      }
      return undefined;
    },
  });
}

/** better-call's APIError, duck-typed so a duplicated copy of the class still matches. */
interface ApiErrorLike extends Error {
  statusCode: number;
  body?: { message?: unknown; code?: unknown };
}

function isApiError(err: unknown): err is ApiErrorLike {
  if (!(err instanceof Error) || err.name !== "APIError") return false;
  const { statusCode } = err as { statusCode?: unknown };
  return typeof statusCode === "number" && statusCode >= 400 && statusCode <= 599;
}

/**
 * Map a thrown value onto the JSON error body this API always answers with.
 *
 * A 4xx keeps its message: it describes what the caller did wrong and the UI
 * shows it. A 5xx never does — those carry connection strings, SQL and
 * internal paths — so it is logged and replaced with a fixed string.
 */
export function toErrorResponse(err: unknown, c: Context): Response {
  if (err instanceof HTTPException) {
    // Preserve custom headers (e.g. Retry-After from rate limiting)
    const errResponse = err.getResponse();
    const headers: Record<string, string> = {};
    errResponse.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return c.json({ error: err.message }, { status: err.status, headers });
  }

  if (isApiError(err)) {
    if (err.statusCode < 500) {
      const message = typeof err.body?.message === "string" ? err.body.message : err.message;
      return c.json(
        { error: message || "Bad request" },
        { status: err.statusCode as ContentfulStatusCode },
      );
    }
    getLogger("app").withError(err).error("Auth API error");
    return c.json(
      { error: "Internal server error" },
      { status: err.statusCode as ContentfulStatusCode },
    );
  }

  const appLogger = getLogger("app");
  if (err instanceof Error) {
    appLogger.withError(err).error("Unhandled error");
  } else {
    appLogger.withMetadata({ error: err }).error("Unhandled error");
  }
  return c.json({ error: "Internal server error" }, 500);
}
