import { and, eq, isNull, lte, ne, or, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";
import { appSettings, users } from "#db";
import type { Db } from "#db";
import type { AppVariables } from "../context.js";

const LAST_ADMIN_LOCK_KEY = "auth:last-admin-lock";

/** Where app.ts mounts Better Auth. The admin plugin nests itself beneath it. */
const AUTH_MOUNT = "/api/auth";

/**
 * The subtree the admin plugin owns.
 *
 * app.ts registers this middleware on the whole subtree rather than on three
 * named endpoints. The previous list-of-paths version guarded set-role,
 * ban-user and remove-user and missed /admin/update-user, which performs the
 * very same role and ban writes — so the invariant, its row lock and its 409
 * contract were simply not on the code path an attacker would use.
 */
export const ADMIN_ENDPOINT_PREFIX = `${AUTH_MOUNT}/admin/`;

interface AdminActionBody {
  userId?: unknown;
  role?: unknown;
  banned?: unknown;
  /** /admin/update-user nests the same fields one level down. */
  data?: unknown;
}

/**
 * How an admin-plugin endpoint can shrink the set of active admins.
 *
 * - `always` — reaching the handler at all removes the target's authority
 *   (ban-user always bans, remove-user always deletes; neither carries a field
 *   that could say otherwise).
 * - `body`   — depends on the role/ban fields the caller sent.
 * - `never`  — cannot reduce the set, whatever the body says.
 */
export type AdminEndpointEffect = "always" | "body" | "never";

/**
 * Every endpoint Better Auth's admin plugin exposes, classified.
 *
 * Keyed by the plugin-relative path (`endpoint.path`), so
 * last-admin.test.ts can enumerate `admin().endpoints` from the installed
 * package and assert this table is exhaustive. That test is the mechanism that
 * stops the next Better Auth upgrade from quietly reintroducing 59m.12: a new
 * endpoint fails the suite until someone classifies it here.
 *
 * Verified against better-auth 1.6.25, dist/plugins/admin/routes.mjs.
 */
export const ADMIN_ENDPOINT_EFFECTS: Readonly<Record<string, AdminEndpointEffect>> = {
  // Writes `role` from the top level of the body.
  "/admin/set-role": "body",
  // Writes `data.role` AND the ban fields from `data`. Its only self-protection
  // is YOU_CANNOT_BAN_YOURSELF; there is no equivalent guard on role, which is
  // what made it the hole in the old three-path list.
  "/admin/update-user": "body",
  "/admin/ban-user": "always",
  "/admin/remove-user": "always",

  // Only adds users, and carries no userId to aim at an existing one. Its
  // top-level `role` field is a creation attribute, not a demotion.
  "/admin/create-user": "never",
  // Restores authority rather than removing it.
  "/admin/unban-user": "never",
  // Ends sessions; the role survives, so the account is still an admin.
  "/admin/revoke-user-session": "never",
  "/admin/revoke-user-sessions": "never",
  // Borrows a session, changes no user row.
  "/admin/impersonate-user": "never",
  "/admin/stop-impersonating": "never",
  // Changes a credential, not an authority.
  "/admin/set-user-password": "never",
  // Read-only.
  "/admin/get-user": "never",
  "/admin/list-users": "never",
  "/admin/list-user-sessions": "never",
  "/admin/has-permission": "never",
};

/**
 * Fail safe for an endpoint this table has not seen.
 *
 * A Better Auth upgrade that adds a role- or ban-writing endpoint is covered
 * the moment it ships, without waiting for someone to notice.
 */
const UNKNOWN_ENDPOINT_EFFECT: AdminEndpointEffect = "body";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasKey(value: unknown, key: string): boolean {
  return isRecord(value) && Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Whether a role value still carries admin.
 *
 * Better Auth stores multiple roles as a comma-joined string and accepts either
 * a string or an array on the wire, so both shapes have to be understood. A
 * value that does not mention admin is a demotion.
 */
function grantsAdminRole(role: unknown): boolean {
  const values = Array.isArray(role) ? role : [role];
  return values.some((value) => typeof value === "string" && value.split(",").includes("admin"));
}

function hasAdminRole(role: unknown): boolean {
  return typeof role === "string" && role.split(",").includes("admin");
}

/**
 * Reads a field that lives at the top level on set-role/ban-user and one level
 * down, under `data`, on update-user. Reading only the top level is exactly how
 * the old guard let update-user through: `body.role` was undefined, which read
 * as "no role change", and the check passed.
 */
function readAdminField(
  body: AdminActionBody,
  key: "role" | "banned",
): {
  present: boolean;
  value: unknown;
} {
  if (hasKey(body, key)) return { present: true, value: (body as Record<string, unknown>)[key] };
  if (hasKey(body.data, key)) {
    return { present: true, value: (body.data as Record<string, unknown>)[key] };
  }
  return { present: false, value: undefined };
}

/**
 * Whether this request, if it succeeds, would remove one active admin.
 *
 * `pluginPath` is the path relative to the Better Auth mount, e.g.
 * "/admin/update-user" — the same string the plugin's endpoint objects carry.
 */
export function reducesAdminAuthority(pluginPath: string, body: AdminActionBody): boolean {
  const effect = ADMIN_ENDPOINT_EFFECTS[pluginPath] ?? UNKNOWN_ENDPOINT_EFFECT;
  if (effect === "never") return false;
  if (effect === "always") return true;

  const banned = readAdminField(body, "banned");
  if (banned.present && banned.value === true) return true;

  const role = readAdminField(body, "role");
  if (role.present && !grantsAdminRole(role.value)) return true;

  return false;
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
  if (c.req.method !== "POST" || !c.req.path.startsWith(ADMIN_ENDPOINT_PREFIX)) {
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

  const pluginPath = c.req.path.slice(AUTH_MOUNT.length);
  if (!reducesAdminAuthority(pluginPath, body)) {
    await next();
    return;
  }
  if (typeof body.userId !== "string") {
    await next();
    return;
  }

  // Let Better Auth produce its normal unauthorized/forbidden response. The
  // invariant check must not reveal user or role information to other callers.
  const session = await c.get("auth").api.getSession({ headers: c.req.raw.headers });
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
