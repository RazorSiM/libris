import { createRoute } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { HTTPException } from "hono/http-exception";
import { and, eq } from "drizzle-orm";
import { hash } from "bcryptjs";
import { kosyncCredentials, serviceCredentials } from "#db";
import type { AppVariables } from "../../context.js";
import { BCRYPT_ROUNDS, md5, sealToken, getUserId } from "../../shared/auth.js";
import { isUniqueViolation } from "../../shared/db-errors.js";
import { hashKosyncSecret } from "../../shared/kosync-auth.js";
import { CredentialServiceParamSchema, CredentialPutBodySchema } from "../../shared/validation.js";
import {
  CredentialStatusSchema,
  CredentialUpdatedSchema,
  CredentialDeletedSchema,
} from "../../shared/schemas.js";

// ── GET /{service} ───────────────────────────────────────────────

const getCredentialRoute = createRoute({
  method: "get",
  path: "/{service}",
  tags: ["credentials"],
  summary: "Check service credentials",
  description:
    "Check whether credentials are configured for a service (opds, kosync, or hardcover). Returns the username and timestamps if configured.",
  request: {
    params: CredentialServiceParamSchema,
  },
  responses: {
    200: {
      description: "Credential status",
      content: {
        "application/json": {
          schema: CredentialStatusSchema,
        },
      },
    },
  },
});

// ── PUT /{service} ───────────────────────────────────────────────

const putCredentialRoute = createRoute({
  method: "put",
  path: "/{service}",
  tags: ["credentials"],
  summary: "Set service credentials",
  description:
    "Set or update credentials for a service. Passwords for opds/kosync are bcrypt-hashed. Hardcover tokens are sealed with reversible encryption.",
  request: {
    params: CredentialServiceParamSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: CredentialPutBodySchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Credentials updated",
      content: {
        "application/json": {
          schema: CredentialUpdatedSchema,
        },
      },
    },
    409: { description: "Username already taken for this service" },
  },
});

// ── DELETE /{service} ────────────────────────────────────────────

const deleteCredentialRoute = createRoute({
  method: "delete",
  path: "/{service}",
  tags: ["credentials"],
  summary: "Delete service credentials",
  description: "Remove stored credentials for a service (opds, kosync, or hardcover).",
  request: {
    params: CredentialServiceParamSchema,
  },
  responses: {
    200: {
      description: "Credentials deleted",
      content: {
        "application/json": {
          schema: CredentialDeletedSchema,
        },
      },
    },
    404: { description: "No credentials found for this service" },
  },
});

/**
 * Run a credential write, turning any unique-constraint violation into a 409.
 *
 * The handlers below check for the collisions they know about up front, but a
 * uniqueness rule they do NOT know about still reaches Postgres and comes back
 * as an unhandled 500 with no hint of what went wrong. That is exactly how
 * libris-59m.9 presented: a stale global `(service, username)` unique index
 * meant the second user in an install to connect Hardcover got "Internal server
 * error". The index is gone, but this makes the failure mode legible if any
 * future constraint change reintroduces one.
 */
/**
 * The one refusal a taken KoSync username gets, wherever it is detected.
 *
 * Two code paths reach it — the up-front SELECT and the unique violation the
 * INSERT raises when someone else claimed the name in between — and they have
 * to be indistinguishable to the caller, or the answer depends on how busy the
 * server was (libris-59m.44).
 */
function kosyncUsernameTaken(username: string): HTTPException {
  return new HTTPException(409, {
    message: `Username "${username}" is already taken for kosync`,
  });
}

async function storeCredential(
  service: string,
  username: string,
  write: () => Promise<unknown>,
): Promise<void> {
  try {
    await write();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    throw new HTTPException(409, {
      message: `Could not save ${service} credentials for "${username}": they conflict with an existing record`,
      cause: err,
    });
  }
}

// ── Router ───────────────────────────────────────────────────────

export const credentialsRoutes = createOpenApiRouter<{ Variables: AppVariables }>()
  .openapi(getCredentialRoute, async (c) => {
    const { service } = c.req.valid("param");
    const db = c.get("db");
    const userId = getUserId(c);

    // KoSync moved to its own table; only Hardcover still lives
    // in service_credentials.
    const [row] =
      service === "kosync"
        ? await db
            .select({
              username: kosyncCredentials.username,
              createdAt: kosyncCredentials.createdAt,
              updatedAt: kosyncCredentials.updatedAt,
            })
            .from(kosyncCredentials)
            .where(eq(kosyncCredentials.userId, userId))
            .limit(1)
        : await db
            .select({
              username: serviceCredentials.username,
              createdAt: serviceCredentials.createdAt,
              updatedAt: serviceCredentials.updatedAt,
            })
            .from(serviceCredentials)
            .where(
              and(eq(serviceCredentials.service, service), eq(serviceCredentials.userId, userId)),
            )
            .limit(1);

    if (!row) {
      return c.json({ configured: false, service });
    }

    return c.json({
      configured: true,
      service,
      username: row.username,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    });
  })
  .openapi(putCredentialRoute, async (c) => {
    const { service } = c.req.valid("param");
    const { username, password } = c.req.valid("json");
    const db = c.get("db");
    const env = c.get("env");
    const userId = getUserId(c);

    if (service === "kosync") {
      // One indexed lookup: username is unique across the whole table, so a
      // row belonging to anyone else is a collision.
      const [existing] = await db
        .select({ userId: kosyncCredentials.userId })
        .from(kosyncCredentials)
        .where(eq(kosyncCredentials.username, username))
        .limit(1);
      if (existing && existing.userId !== userId) {
        throw kosyncUsernameTaken(username);
      }

      // A salted, peppered MAC of the value KOReader will put on the wire,
      // which is md5(password) — not the plaintext. The pepper comes from
      // API_SECRET_KEY, so a database-only leak yields nothing to guess
      // against. See shared/kosync-auth.ts for the full rationale.
      const secretHash = hashKosyncSecret(md5(password), env.API_SECRET_KEY);

      // The SELECT above is a check, not a lock. Between it and this INSERT
      // another request can claim the same username, and Postgres — not the
      // handler — is what stops the second one. Every unique violation this
      // statement can raise is that collision: the ON CONFLICT target is
      // kosync_credentials_user_id_uniq, so the per-user constraint is
      // absorbed into the UPDATE branch rather than raised, leaving
      // kosync_credentials_username_uniq as the only index left to violate —
      // from either branch, since the UPDATE rewrites `username` too.
      // Without this the loser of the race got a 500 (libris-59m.44).
      try {
        await db
          .insert(kosyncCredentials)
          .values({ userId, username, secretHash })
          .onConflictDoUpdate({
            target: kosyncCredentials.userId,
            set: { username, secretHash, updatedAt: new Date() },
          });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        throw kosyncUsernameTaken(username);
      }

      return c.json({ service, username, updated: true });
    }

    // No collision check: only Hardcover reaches here, and its "username" is a
    // label for the user's own token rather than an identity anyone else could
    // claim. The OPDS branch that used to live here is gone with the service.
    // Only Hardcover reaches here, and it needs the original value back to call
    // the API — so it is sealed with reversible encryption, not hashed.
    const passwordHash =
      service === "hardcover"
        ? await sealToken(password, env.API_SECRET_KEY)
        : await hash(password, BCRYPT_ROUNDS);

    await storeCredential(service, username, () =>
      db
        .insert(serviceCredentials)
        .values({ service, userId, username, passwordHash })
        .onConflictDoUpdate({
          target: [serviceCredentials.service, serviceCredentials.userId],
          targetWhere: eq(serviceCredentials.userId, userId),
          set: { username, passwordHash, updatedAt: new Date() },
        }),
    );

    return c.json({ service, username, updated: true });
  })
  .openapi(deleteCredentialRoute, async (c) => {
    const { service } = c.req.valid("param");
    const db = c.get("db");
    const userId = getUserId(c);

    const deleted =
      service === "kosync"
        ? await db
            .delete(kosyncCredentials)
            .where(eq(kosyncCredentials.userId, userId))
            .returning({ id: kosyncCredentials.id })
        : await db
            .delete(serviceCredentials)
            .where(
              and(eq(serviceCredentials.service, service), eq(serviceCredentials.userId, userId)),
            )
            .returning({ id: serviceCredentials.id });

    if (deleted.length === 0) {
      throw new HTTPException(404, {
        message: `No credentials found for service: ${service}`,
      });
    }

    return c.json({ service, deleted: true });
  });
