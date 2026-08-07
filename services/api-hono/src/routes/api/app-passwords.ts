import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { and, desc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { apiKeys } from "#db";
import type { AppVariables } from "../../context.js";
import { getUserId } from "../../shared/auth.js";
import { getLogger } from "../../lib/logger.js";

const logger = getLogger("app-passwords");

/**
 * App passwords — the credential an e-reader, script or OPDS client uses.
 *
 * These replace the bespoke /api/auth/keys routes. Creation goes through the
 * plugin, which is the only way to get a correctly hashed key and its plaintext.
 *
 * Listing and revoking read the table directly instead. The plugin's own
 * listApiKeys and deleteApiKey scope themselves to whatever session is in the
 * request headers and take no userId, so there is no server-side way to ask
 * them for "this user's keys" — and going through headers would make this router
 * depend on the credential the caller happened to authenticate with. Reading
 * `referenceId` is both simpler and explicitly scoped.
 *
 * Deleting the row is enough: nothing caches, so the next request using that
 * key fails (pinned by the revocation test in middleware/auth.test.ts).
 *
 * The plaintext is returned exactly once, on creation. Only a hash is stored,
 * so there is no endpoint that could show it again.
 */

const AppPasswordSchema = z
  .object({
    id: z.string().openapi({ description: "Credential id, used to revoke it" }),
    name: z.string().nullable().openapi({ description: "Label the user gave this device" }),
    start: z
      .string()
      .nullable()
      .openapi({ description: "First few characters, to tell credentials apart in a list" }),
    enabled: z.boolean().nullable(),
    createdAt: z.date().openapi({ description: "When it was issued" }),
    lastRequest: z
      .date()
      .nullable()
      .openapi({ description: "Last time it was used, or null if never" }),
  })
  .openapi("AppPassword");

const AppPasswordListSchema = z
  .object({ keys: z.array(AppPasswordSchema) })
  .openapi("AppPasswordList");

const AppPasswordCreatedSchema = AppPasswordSchema.extend({
  key: z.string().openapi({
    description:
      "The credential itself, shown only once. Send it as Authorization: Bearer, " +
      "as x-api-key, or as the password half of HTTP Basic.",
  }),
}).openapi("AppPasswordCreated");

/**
 * The apiKey plugin enforces its own `maximumNameLength`, 32 by default, and
 * `lib/auth.ts` does not raise it. This schema used to allow 200, so a label
 * of 33 to 200 characters passed validation and was then rejected inside the
 * plugin — an APIError the handler did not catch, i.e. a 500 for ordinary user
 * input typed straight into the form. Keep this number, the plugin's limit and
 * the Vue form's limit equal; raise all three together if 32 proves too short.
 */
export const MAX_APP_PASSWORD_NAME_LENGTH = 32;

const CreateBodySchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(MAX_APP_PASSWORD_NAME_LENGTH)
      .openapi({
        description: `Label for the device or script this is for, at most ${MAX_APP_PASSWORD_NAME_LENGTH} characters`,
      }),
  })
  .openapi("AppPasswordCreate");

const listRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["app-passwords"],
  summary: "List your app passwords",
  description:
    "Every credential issued to the signed-in user, for the Connected Devices list. The " +
    "credentials themselves are hashed and never returned — only their labels, prefixes and " +
    "last-used timestamps.",
  responses: {
    200: {
      description: "The caller's app passwords",
      content: { "application/json": { schema: AppPasswordListSchema } },
    },
    401: { description: "Not authenticated" },
  },
});

const createRoute_ = createRoute({
  method: "post",
  path: "/",
  tags: ["app-passwords"],
  summary: "Issue an app password",
  description:
    "Create a credential for an e-reader, OPDS client or script. The plaintext is in the " +
    "response and is never retrievable again — show it to the user immediately.",
  request: {
    body: { content: { "application/json": { schema: CreateBodySchema } }, required: true },
  },
  responses: {
    201: {
      description: "The new app password, including its plaintext",
      content: { "application/json": { schema: AppPasswordCreatedSchema } },
    },
    400: { description: "Invalid request body" },
    401: { description: "Not authenticated" },
  },
});

const deleteRoute = createRoute({
  method: "delete",
  path: "/{id}",
  tags: ["app-passwords"],
  summary: "Revoke an app password",
  description:
    "Revoke a credential immediately — there is no session cache, so the next request using it " +
    "fails. Revoking someone else's credential returns 404 rather than 403, so ids cannot be " +
    "probed for existence.",
  request: { params: z.object({ id: z.string().openapi({ description: "Credential id" }) }) },
  responses: {
    204: { description: "Revoked" },
    401: { description: "Not authenticated" },
    404: { description: "No such credential belonging to the caller" },
  },
});

export const appPasswordRoutes = createOpenApiRouter<{ Variables: AppVariables }>()
  .openapi(listRoute, async (c) => {
    const db = c.get("db");
    const userId = getUserId(c);

    const keys = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        start: apiKeys.start,
        enabled: apiKeys.enabled,
        createdAt: apiKeys.createdAt,
        lastRequest: apiKeys.lastRequest,
      })
      .from(apiKeys)
      .where(eq(apiKeys.referenceId, userId))
      .orderBy(desc(apiKeys.createdAt));

    return c.json({ keys }, 200);
  })

  .openapi(createRoute_, async (c) => {
    const auth = c.get("auth");
    const userId = getUserId(c);
    const { name } = c.req.valid("json");

    const created = await auth.api.createApiKey({ body: { userId, name } });
    logger.info(`App password "${name}" issued to ${userId}`);

    return c.json(
      {
        id: created.id,
        name: created.name,
        start: created.start,
        enabled: created.enabled,
        createdAt: created.createdAt,
        lastRequest: created.lastRequest,
        key: created.key,
      },
      201,
    );
  })

  .openapi(deleteRoute, async (c) => {
    const db = c.get("db");
    const userId = getUserId(c);
    const { id } = c.req.valid("param");

    // Owner and id in one WHERE, so someone else's key is simply not found.
    // Answering 403 would confirm the id exists, which is exactly what an
    // attacker enumerating ids wants to learn.
    const deleted = await db
      .delete(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.referenceId, userId)))
      .returning({ id: apiKeys.id });

    if (deleted.length === 0) {
      throw new HTTPException(404, { message: "App password not found" });
    }
    logger.info(`App password ${id} revoked by ${userId}`);

    return c.body(null, 204);
  });
