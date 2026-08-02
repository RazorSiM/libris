import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { and, eq } from "drizzle-orm";
import { hash } from "bcryptjs";
import { kosyncCredentials, serviceCredentials } from "#db";
import type { AppVariables } from "../../context.js";
import { BCRYPT_ROUNDS, md5, sealToken, getUserId } from "../../shared/auth.js";
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

// ── Router ───────────────────────────────────────────────────────

export const credentialsRoutes = new OpenAPIHono<{ Variables: AppVariables }>()
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
        throw new HTTPException(409, {
          message: `Username "${username}" is already taken for kosync`,
        });
      }

      // sha256 of the value KOReader will put on the wire, which is
      // md5(password) — not the plaintext. See shared/kosync-auth.ts.
      await db
        .insert(kosyncCredentials)
        .values({ userId, username, secretHash: hashKosyncSecret(md5(password)) })
        .onConflictDoUpdate({
          target: kosyncCredentials.userId,
          set: { username, secretHash: hashKosyncSecret(md5(password)), updatedAt: new Date() },
        });

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

    await db
      .insert(serviceCredentials)
      .values({ service, userId, username, passwordHash })
      .onConflictDoUpdate({
        target: [serviceCredentials.service, serviceCredentials.userId],
        targetWhere: eq(serviceCredentials.userId, userId),
        set: { username, passwordHash, updatedAt: new Date() },
      });

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
