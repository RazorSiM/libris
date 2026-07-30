import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { and, eq } from "drizzle-orm";
import { hash } from "bcryptjs";
import { serviceCredentials } from "#db";
import type { AppVariables } from "../../context.js";
import { clearAuthCaches } from "../../middleware/auth.js";
import { BCRYPT_ROUNDS, md5, sealToken, getApiKeyId } from "../../shared/auth.js";
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
    const apiKeyId = getApiKeyId(c);

    const [row] = await db
      .select({
        username: serviceCredentials.username,
        createdAt: serviceCredentials.createdAt,
        updatedAt: serviceCredentials.updatedAt,
      })
      .from(serviceCredentials)
      .where(
        and(eq(serviceCredentials.service, service), eq(serviceCredentials.apiKeyId, apiKeyId)),
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
    const apiKeyId = getApiKeyId(c);

    // Prevent username collision: reject if another user already has this username for this service
    if (service === "opds" || service === "kosync") {
      const [existing] = await db
        .select({ id: serviceCredentials.id })
        .from(serviceCredentials)
        .where(
          and(eq(serviceCredentials.service, service), eq(serviceCredentials.username, username)),
        )
        .limit(1);
      if (existing) {
        // Check it's not the current user's own credential being updated
        const [own] = await db
          .select({ id: serviceCredentials.id })
          .from(serviceCredentials)
          .where(
            and(
              eq(serviceCredentials.service, service),
              eq(serviceCredentials.username, username),
              eq(serviceCredentials.apiKeyId, apiKeyId),
            ),
          )
          .limit(1);
        if (!own) {
          throw new HTTPException(409, {
            message: `Username "${username}" is already taken for ${service}`,
          });
        }
      }
    }

    // Services that need the original value back (API tokens) use reversible encryption.
    // Services that only verify passwords (OPDS, KoSync) use bcrypt (one-way hash).
    // KoSync: hash md5(password) because KOReader sends md5-hashed passwords.
    const needsReversible = service === "hardcover";
    const valueToHash = service === "kosync" ? md5(password) : password;
    const passwordHash = needsReversible
      ? await sealToken(password, env.API_SECRET_KEY)
      : await hash(valueToHash, BCRYPT_ROUNDS);

    await db
      .insert(serviceCredentials)
      .values({ service, apiKeyId, username, passwordHash })
      .onConflictDoUpdate({
        target: [serviceCredentials.service, serviceCredentials.apiKeyId],
        targetWhere: eq(serviceCredentials.apiKeyId, apiKeyId),
        set: { username, passwordHash, updatedAt: new Date() },
      });

    if (service === "opds") {
      clearAuthCaches();
    }

    return c.json({ service, username, updated: true });
  })
  .openapi(deleteCredentialRoute, async (c) => {
    const { service } = c.req.valid("param");
    const db = c.get("db");
    const apiKeyId = getApiKeyId(c);

    const deleted = await db
      .delete(serviceCredentials)
      .where(
        and(eq(serviceCredentials.service, service), eq(serviceCredentials.apiKeyId, apiKeyId)),
      )
      .returning({ id: serviceCredentials.id });

    if (deleted.length === 0) {
      throw new HTTPException(404, {
        message: `No credentials found for service: ${service}`,
      });
    }

    if (service === "opds") {
      clearAuthCaches();
    }

    return c.json({ service, deleted: true });
  });
