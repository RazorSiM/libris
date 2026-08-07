import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";
import { appSettings, users } from "#db";
import type { Db } from "#db";
import type { AppVariables } from "../context.js";
import { withTrustedClientIp } from "../shared/request-ip.js";

const LAST_ADMIN_LOCK_KEY = "auth:last-admin-lock";

interface AdminActionBody {
  userId?: unknown;
  role?: unknown;
}

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function withLastAdminLock(
  db: Db,
  targetUserId: string,
  action: (tx: Transaction) => Promise<void>,
): Promise<void> {
  const now = new Date();
  const isActiveAdmin = and(
    eq(users.role, "admin"),
    or(isNull(users.banned), ne(users.banned, true), lte(users.banExpires, now)),
  );

  await db.transaction(async (tx) => {
    await tx
      .insert(appSettings)
      .values({ key: LAST_ADMIN_LOCK_KEY, value: {} })
      .onConflictDoNothing({ target: appSettings.key });
    await tx.execute(
      sql`select ${appSettings.key} from ${appSettings} where ${appSettings.key} = ${LAST_ADMIN_LOCK_KEY} for update`,
    );

    const [target, activeAdmins] = await Promise.all([
      tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.id, targetUserId), isActiveAdmin))
        .limit(1),
      tx.select({ id: users.id }).from(users).where(isActiveAdmin).limit(2),
    ]);

    if (target.length === 1 && activeAdmins.length === 1) {
      throw new HTTPException(409, {
        message: "The last active admin cannot be demoted, banned, or removed",
      });
    }

    await action(tx);
  });
}

function removesAdminRole(role: unknown): boolean {
  const roles = Array.isArray(role) ? role : [role];
  return !roles.includes("admin");
}

function hasAdminRole(role: unknown): boolean {
  return typeof role === "string" && role.split(",").includes("admin");
}

/**
 * Serializes operations that can reduce the active-admin set and refuses the
 * operation when its target is the last active admin.
 *
 * The lock is a real PostgreSQL row rather than process-local state. That is
 * important even while Libris normally runs one API process: two containers
 * during a rolling restart must enforce the same invariant together.
 */
export const lastAdminMiddleware: MiddlewareHandler<{ Variables: AppVariables }> = async (
  c,
  next,
) => {
  if (c.req.method !== "POST") {
    await next();
    return;
  }

  let body: AdminActionBody;
  try {
    body = (await c.req.raw.clone().json()) as AdminActionBody;
  } catch {
    await next();
    return;
  }

  const isSetRole = c.req.path === "/api/auth/admin/set-role";
  if (isSetRole && !removesAdminRole(body.role)) {
    await next();
    return;
  }
  if (typeof body.userId !== "string") {
    await next();
    return;
  }

  // Let Better Auth produce its normal unauthorized/forbidden response. The
  // invariant check must not reveal user or role information to other callers.
  //
  // withTrustedClientIp, not the raw headers (libris-59m.42). lib/auth.ts
  // configures Better Auth to read the client address from one private header
  // on the assumption that the app always overwrites it with the address
  // resolved from the TCP peer — but app.ts only does that inside the
  // /api/auth/* catch-all HANDLER, which runs after this middleware. Passing
  // c.req.raw.headers here handed Better Auth whatever the client sent.
  const session = await c
    .get("auth")
    .api.getSession({ headers: withTrustedClientIp(c.req.raw.headers, c.get("clientIp")) });
  if (!hasAdminRole(session?.user.role)) {
    await next();
    return;
  }

  if (c.get("env").NODE_ENV === "test") {
    // PGlite has one connection, so re-entering it through Better Auth while a
    // transaction is open deadlocks. The lock primitive itself is exercised
    // concurrently below its HTTP tests; this branch only adapts that embedded
    // test database limitation.
    await withLastAdminLock(c.get("db"), body.userId, async () => {});
    await next();
    return;
  }

  await withLastAdminLock(c.get("db"), body.userId, async () => {
    // Keep the database lock until Better Auth has completed its write. Its
    // own handler remains responsible for permissions, validation, session
    // revocation, hooks, and the exact public response contract.
    await next();
  });
};
