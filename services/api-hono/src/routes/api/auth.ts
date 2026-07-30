import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import { compare } from "bcryptjs";
import { apiKeys } from "#db";
import { eq, or } from "drizzle-orm";
import type { AppVariables } from "../../context.js";
import { clearAuthCaches } from "../../middleware/auth.js";
import { generateApiKey, KEY_PREFIX_LENGTH, requireAdmin, getApiKeyId } from "../../shared/auth.js";
import { writeSession, readSession, clearSession } from "../../shared/session.js";
import {
  IdParamSchema,
  AuthSetupBodySchema,
  AuthKeysCreateBodySchema,
} from "../../shared/validation.js";
import {
  ApiKeyCreatedSchema,
  ApiKeyListSchema,
  ApiKeyDeletedSchema,
} from "../../shared/schemas.js";
import { getLogger } from "../../lib/logger.js";
const logger = getLogger("auth");

// ── Route definitions ────────────────────────────────────────────────

const setupRoute = createRoute({
  method: "post",
  path: "/setup",
  tags: ["auth"],
  summary: "Initial setup",
  description: "Create the first API key. Only works when no keys exist yet.",
  request: {
    body: {
      content: {
        "application/json": { schema: AuthSetupBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "API key created - returns the raw key (shown only once)",
      content: {
        "application/json": { schema: ApiKeyCreatedSchema },
      },
    },
    409: { description: "Setup already completed" },
  },
});

const listKeysRoute = createRoute({
  method: "get",
  path: "/keys",
  tags: ["auth"],
  summary: "List API keys",
  description: "List all API keys (hashes are never exposed)",
  responses: {
    200: {
      description: "Array of API key metadata",
      content: {
        "application/json": { schema: ApiKeyListSchema },
      },
    },
  },
});

const createKeyRoute = createRoute({
  method: "post",
  path: "/keys",
  tags: ["auth"],
  summary: "Create API key",
  description: "Generate a new API key with the given label",
  request: {
    body: {
      required: true,
      content: {
        "application/json": { schema: AuthKeysCreateBodySchema },
      },
    },
  },
  responses: {
    201: {
      description: "API key created - returns the raw key (shown only once)",
      content: {
        "application/json": { schema: ApiKeyCreatedSchema },
      },
    },
  },
});

const deleteKeyRoute = createRoute({
  method: "delete",
  path: "/keys/{id}",
  tags: ["auth"],
  summary: "Delete API key",
  description: "Revoke an API key. Cannot delete the last key or the key used for this request.",
  request: {
    params: IdParamSchema,
  },
  responses: {
    200: {
      description: "Key deleted",
      content: {
        "application/json": { schema: ApiKeyDeletedSchema },
      },
    },
    404: { description: "Key not found" },
    409: { description: "Cannot delete the last key or the active key" },
  },
});

// ── Session routes ──────────────────────────────────────────────────

const loginRoute = createRoute({
  method: "post",
  path: "/login",
  tags: ["auth"],
  summary: "Login with API key",
  description:
    "Validates the API key and sets an httpOnly session cookie. Used by the SPA frontend.",
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({ apiKey: z.string().min(1) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "Login successful",
      content: {
        "application/json": {
          schema: z.object({ authenticated: z.boolean() }),
        },
      },
    },
    401: { description: "Invalid API key" },
  },
});

const logoutRoute = createRoute({
  method: "post",
  path: "/logout",
  tags: ["auth"],
  summary: "Logout",
  description: "Clears the session cookie.",
  responses: {
    200: {
      description: "Logged out",
      content: {
        "application/json": {
          schema: z.object({ authenticated: z.boolean() }),
        },
      },
    },
  },
});

const sessionRoute = createRoute({
  method: "get",
  path: "/session",
  tags: ["auth"],
  summary: "Check session",
  description:
    "Returns whether the current session cookie is valid, with user info if authenticated.",
  responses: {
    200: {
      description: "Session status",
      content: {
        "application/json": {
          schema: z.object({
            authenticated: z.boolean(),
            isAdmin: z.boolean().optional(),
            label: z.string().optional(),
            apiKeyId: z.string().optional(),
          }),
        },
      },
    },
  },
});

// ── Handlers ─────────────────────────────────────────────────────────

export const authRoutes = new OpenAPIHono<{ Variables: AppVariables }>()
  .openapi(setupRoute, async (c) => {
    const db = c.get("db");
    const { label: bodyLabel } = c.req.valid("json");
    const label = bodyLabel || "Initial setup key";

    const { rawKey, keyPrefix, keyHash } = await generateApiKey();

    // Atomic check-and-insert: only insert if no keys exist (serializable transaction)
    const row = await db.transaction(
      async (tx) => {
        const existing = await tx.select({ id: apiKeys.id }).from(apiKeys).limit(1);
        if (existing.length > 0) {
          throw new HTTPException(409, {
            message: "Setup already completed - API keys already exist",
          });
        }
        const [inserted] = await tx
          .insert(apiKeys)
          .values({ keyPrefix, keyHash, label, isAdmin: true })
          .returning({ id: apiKeys.id, label: apiKeys.label, createdAt: apiKeys.createdAt });
        return inserted;
      },
      { isolationLevel: "serializable" },
    );

    logger.info(`Initial API key created: ${label}`);

    return c.json(
      {
        id: row!.id,
        key: rawKey,
        label: row!.label,
        createdAt: row!.createdAt,
      },
      201,
    );
  })
  .openapi(listKeysRoute, async (c) => {
    const db = c.get("db");
    const currentKeyId = getApiKeyId(c);
    const isAdmin = c.get("isAdmin");

    const rows = await db
      .select({
        id: apiKeys.id,
        label: apiKeys.label,
        isAdmin: apiKeys.isAdmin,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
      })
      .from(apiKeys)
      .orderBy(apiKeys.createdAt);

    // Non-admin users only see their own key
    const filtered = isAdmin ? rows : rows.filter((r) => r.id === currentKeyId);

    return c.json({ keys: filtered }, 200);
  })
  .openapi(createKeyRoute, async (c) => {
    requireAdmin(c);
    const db = c.get("db");
    const { label } = c.req.valid("json");

    const { rawKey, keyPrefix, keyHash } = await generateApiKey();

    const [row] = await db
      .insert(apiKeys)
      .values({ keyPrefix, keyHash, label })
      .returning({ id: apiKeys.id, label: apiKeys.label, createdAt: apiKeys.createdAt });

    logger.info(`API key created: ${label}`);

    return c.json(
      {
        id: row!.id,
        key: rawKey,
        label: row!.label,
        createdAt: row!.createdAt,
      },
      201,
    );
  })
  .openapi(deleteKeyRoute, async (c) => {
    requireAdmin(c);
    const db = c.get("db");
    const { id } = c.req.valid("param");

    // Prevent deleting the key used for this request
    if (c.get("apiKeyId") === id) {
      throw new HTTPException(409, { message: "Cannot delete the key used for this request" });
    }

    // Atomic check-and-delete: prevent deleting the last key (serializable transaction)
    const deleted = await db.transaction(
      async (tx) => {
        const allKeys = await tx.select({ id: apiKeys.id, isAdmin: apiKeys.isAdmin }).from(apiKeys);
        if (allKeys.length <= 1) {
          throw new HTTPException(409, { message: "Cannot delete the last API key" });
        }

        // Prevent deleting the last admin key - would lock out admin access
        const targetKey = allKeys.find((k) => k.id === id);
        if (targetKey?.isAdmin) {
          const adminCount = allKeys.filter((k) => k.isAdmin).length;
          if (adminCount <= 1) {
            throw new HTTPException(400, {
              message: "Cannot delete the last admin key",
            });
          }
        }

        const result = await tx
          .delete(apiKeys)
          .where(eq(apiKeys.id, id))
          .returning({ id: apiKeys.id });

        if (result.length === 0) {
          throw new HTTPException(404, { message: "API key not found" });
        }

        return result;
      },
      { isolationLevel: "serializable" },
    );

    // Invalidate auth caches to prevent deleted key from being used during cache window
    clearAuthCaches();

    logger.info(`API key deleted: ${id}`);

    return c.json({ deleted: true, id: deleted[0]!.id }, 200);
  })
  .openapi(loginRoute, async (c) => {
    const db = c.get("db");
    const { apiKey } = c.req.valid("json");

    // Validate key against DB (same logic as auth middleware)
    const prefix = apiKey.substring(0, KEY_PREFIX_LENGTH);
    const candidates = await db
      .select()
      .from(apiKeys)
      .where(or(eq(apiKeys.keyPrefix, prefix), eq(apiKeys.keyPrefix, "")));

    let valid = false;
    for (const row of candidates) {
      if (await compare(apiKey, row.keyHash)) {
        valid = true;
        break;
      }
    }

    if (!valid) {
      throw new HTTPException(401, { message: "Invalid API key" });
    }

    await writeSession(c, { apiKey });
    return c.json({ authenticated: true }, 200);
  })
  .openapi(logoutRoute, async (c) => {
    clearSession(c);
    return c.json({ authenticated: false }, 200);
  })
  .openapi(sessionRoute, async (c) => {
    const session = await readSession(c);
    if (!session?.apiKey) {
      return c.json({ authenticated: false }, 200);
    }

    // Verify the key in the session is still valid
    const db = c.get("db");
    const prefix = session.apiKey.substring(0, KEY_PREFIX_LENGTH);
    const candidates = await db
      .select()
      .from(apiKeys)
      .where(or(eq(apiKeys.keyPrefix, prefix), eq(apiKeys.keyPrefix, "")));

    for (const row of candidates) {
      if (await compare(session.apiKey, row.keyHash)) {
        return c.json(
          { authenticated: true, isAdmin: row.isAdmin, label: row.label, apiKeyId: row.id },
          200,
        );
      }
    }

    // Key no longer valid — clear the stale cookie
    clearSession(c);
    return c.json({ authenticated: false }, 200);
  });
