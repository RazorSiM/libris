import { createRoute, z } from "@hono/zod-openapi";
import { createOpenApiRouter } from "../../shared/openapi.js";
import { asc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { accounts, appSettings, users, type Db } from "#db";
import type { AppVariables } from "../../context.js";
import { getLogger } from "../../lib/logger.js";
import { isUniqueViolation } from "../../shared/db-errors.js";

const logger = getLogger("setup");

/**
 * Marks the install as bootstrapped.
 *
 * It exists to make the emptiness check raceable-safe: `app_settings.key` is a
 * primary key, so two concurrent serializable transactions that both see no
 * credential cannot both insert it. Without it there is nothing for the
 * database to serialise on — the check reads rows that do not exist yet, and
 * Better Auth writes the account through its own adapter, outside any
 * transaction we control.
 */
const BOOTSTRAP_KEY = "auth.bootstrapped";

/**
 * How long a claim is honoured before it is treated as abandoned.
 *
 * Long enough to cover creating one user, short enough that a crash between
 * claiming and creating does not lock a fresh install out for any length of
 * time worth caring about.
 */
const CLAIM_LEASE_MS = 60_000;

/** Better Auth's providerId for an email+password credential. */
const CREDENTIAL_PROVIDER = "credential";

/**
 * Whether anyone on this install can sign in with a password.
 *
 * The gate is the CREDENTIAL, not the user row. Gating on "does any user
 * exist" locked out every upgrade of a pre-Better-Auth install: the cutover
 * migration creates one user per legacy api key but deliberately creates no
 * `accounts` row (a bcrypt key hash is not a password hash), so users existed,
 * nobody could sign in, and this endpoint answered 409 — with the admin
 * endpoints that could have fixed it all requiring an admin session nobody
 * could obtain. See libris-59m.4.
 */
async function hasCredential(db: Pick<Db, "select">): Promise<boolean> {
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.providerId, CREDENTIAL_PROVIDER))
    .limit(1);
  return Boolean(row);
}

/**
 * The existing user this bootstrap should attach the credential to.
 *
 * Only ever reached when no credential exists anywhere, i.e. the migrated
 * state. Creating a second user for a person who already has a row would
 * strand their books, reading history and Hardcover token on the old id, so
 * the flow adopts a row instead of adding one.
 *
 * Preference order:
 *   1. the user already holding the submitted email — the operator naming
 *      which migrated row is theirs;
 *   2. the oldest admin, which is the row the cutover migration assigned
 *      orphaned books to;
 *   3. the oldest user, promoted to admin, for an install whose legacy keys
 *      were all non-admin.
 */
async function findAdoptableUser(db: Db, email: string) {
  const columns = { id: users.id, email: users.email } as const;

  const [byEmail] = await db
    .select(columns)
    .from(users)
    .where(eq(users.email, email.toLowerCase()))
    .limit(1);
  if (byEmail) return byEmail;

  const [oldestAdmin] = await db
    .select(columns)
    .from(users)
    .where(eq(users.role, "admin"))
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1);
  if (oldestAdmin) return oldestAdmin;

  const [oldest] = await db
    .select(columns)
    .from(users)
    .orderBy(asc(users.createdAt), asc(users.id))
    .limit(1);
  return oldest ?? null;
}

const SetupBody = z
  .object({
    email: z.email().openapi({ description: "Email address for the first admin" }),
    password: z
      .string()
      .min(8)
      .max(128)
      .openapi({ description: "Password for the first admin, at least 8 characters" }),
    name: z.string().min(1).max(200).openapi({ description: "Display name" }),
  })
  .openapi("SetupRequest");

const SetupResponse = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    role: z.string(),
    adopted: z.boolean().openapi({
      description:
        "True when the credential was attached to a user that already existed (an upgraded install) rather than a newly created one.",
    }),
  })
  .openapi("SetupResponse");

const StatusResponse = z
  .object({
    required: z.boolean().openapi({
      description:
        "True while nobody on this install can sign in with a password, i.e. it still needs its first admin credential.",
    }),
  })
  .openapi("SetupStatus");

const statusRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["auth"],
  summary: "Whether this install still needs setting up",
  description:
    "Lets the sign-in page decide between offering sign-in and offering first-run setup. Public, " +
    "because there is no account to authenticate with when the answer is yes. Returns a bare " +
    "boolean on purpose — anything richer would be an unauthenticated window into who exists " +
    "on this server. True both for a fresh install and for an upgraded one whose users were " +
    "created by the auth cutover migration and therefore have no password yet.",
  responses: {
    200: {
      description: "Setup status",
      content: { "application/json": { schema: StatusResponse } },
    },
  },
});

const setupRoute = createRoute({
  method: "post",
  path: "/",
  tags: ["auth"],
  summary: "Create or recover the first admin",
  description:
    "First-run bootstrap. Available only while nobody on this install can sign in with a " +
    "password — every later account is created by an admin, and self-registration is disabled. " +
    "On a fresh install it creates the first user with role admin. On an install upgraded from " +
    "pre-Better-Auth Libris, where the cutover migration created users with no credential, it " +
    "attaches the submitted email and password to an EXISTING user (the one already holding " +
    "that email, else the oldest admin, else the oldest user promoted to admin) rather than " +
    "creating a duplicate person. Returns 409 once any credential exists, so this is safe to " +
    "leave mounted.",
  request: {
    body: { content: { "application/json": { schema: SetupBody } }, required: true },
  },
  responses: {
    201: {
      description: "The first admin credential was created",
      content: { "application/json": { schema: SetupResponse } },
    },
    400: { description: "Invalid request body" },
    409: { description: "Setup has already been completed" },
  },
});

export const setupRoutes = createOpenApiRouter<{ Variables: AppVariables }>()
  .openapi(statusRoute, async (c) => {
    const db = c.get("db");
    return c.json({ required: !(await hasCredential(db)) }, 200);
  })

  .openapi(setupRoute, async (c) => {
    const db = c.get("db");
    const auth = c.get("auth");
    const { email, password, name } = c.req.valid("json");

    // Claim the bootstrap first, in its own serializable transaction. Better
    // Auth writes the user and its credential account through its own adapter,
    // outside any transaction we control, so the claim is what has to be
    // exclusive — not the creation.
    await db
      .transaction(
        async (tx) => {
          if (await hasCredential(tx)) {
            throw new HTTPException(409, { message: "Setup already completed" });
          }

          // A live claim means another request is between claiming and
          // creating, so this one loses. It has to be a timed lease rather than
          // a bare flag: the two cases "someone is mid-bootstrap" and "someone
          // crashed mid-bootstrap" look identical otherwise, and treating every
          // leftover claim as stale would let sequentially-executed requests
          // each clear the previous claim and all succeed.
          const [claim] = await tx
            .select()
            .from(appSettings)
            .where(eq(appSettings.key, BOOTSTRAP_KEY))
            .limit(1);
          const claimedAt = (claim?.value as { claimedAt?: number } | undefined)?.claimedAt ?? 0;
          if (Date.now() - claimedAt < CLAIM_LEASE_MS) {
            throw new HTTPException(409, { message: "Setup already completed" });
          }

          await tx.delete(appSettings).where(eq(appSettings.key, BOOTSTRAP_KEY));
          await tx.insert(appSettings).values({
            key: BOOTSTRAP_KEY,
            value: { claimedAt: Date.now() },
          });
        },
        { isolationLevel: "serializable" },
      )
      .catch((err: unknown) => {
        if (err instanceof HTTPException) throw err;
        // A serialization failure or a duplicate BOOTSTRAP_KEY means another
        // request won the race. Same answer either way.
        throw new HTTPException(409, { message: "Setup already completed" });
      });

    try {
      const target = await findAdoptableUser(db, email);

      if (!target) {
        // createUser rather than signUpEmail: sign-up is disabled outright (see
        // emailAndPassword.disableSignUp in lib/auth.ts), and the admin plugin
        // permits a server-side call with no session, which is the only way to
        // create an admin when there is no admin yet.
        const created = await auth.api.createUser({
          body: { email, password, name, role: "admin" },
        });

        logger.info(`First admin created: ${email}`);

        return c.json(
          {
            id: created.user.id,
            email: created.user.email,
            name: created.user.name,
            role: "admin",
            adopted: false,
          },
          201,
        );
      }

      // Adoption. There is no session, so the admin plugin's set-user-password
      // endpoint is unreachable (it sits behind adminMiddleware) — the context's
      // own hasher and internal adapter are used instead, which is exactly what
      // that endpoint does once its permission check passes. Going through
      // `password.hash` rather than writing a hash of our own is what keeps the
      // stored format whatever Better Auth is configured to verify.
      const authCtx = await auth.$context;
      const hashedPassword = await authCtx.password.hash(password);

      await authCtx.internalAdapter.createAccount({
        userId: target.id,
        providerId: CREDENTIAL_PROVIDER,
        accountId: target.id,
        password: hashedPassword,
      });

      const updated = await authCtx.internalAdapter.updateUser(target.id, {
        email,
        name,
        role: "admin",
      });

      logger.info(
        `Bootstrap credential attached to existing user ${target.id} (was ${target.email})`,
      );

      return c.json(
        {
          id: target.id,
          email: updated?.email ?? email.toLowerCase(),
          name: updated?.name ?? name,
          role: "admin",
          adopted: true,
        },
        201,
      );
    } catch (err) {
      // Release the claim, or a failed attempt would lock the install out for
      // good with no way back in.
      await db.delete(appSettings).where(eq(appSettings.key, BOOTSTRAP_KEY));

      // Another user already holds this email. Only reachable by racing the
      // lookup above, but it must not surface as a 500 on the one endpoint an
      // operator uses to get back into their install.
      if (isUniqueViolation(err)) {
        throw new HTTPException(409, {
          message: `Another account already uses ${email}`,
          cause: err,
        });
      }
      throw err;
    }
  });
