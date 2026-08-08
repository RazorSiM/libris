/**
 * The two accounts every E2E run shares, and how tests get at them.
 *
 * Credentials live in environment variables set by global-setup.ts so that
 * setup projects, specs and helpers all agree on them without importing each
 * other. The passwords are fixed rather than random: a failing run is much
 * easier to reproduce by hand when you can paste the same password in.
 */

export const ADMIN = {
  email: "e2e-admin@example.test",
  password: "e2e-admin-correct-horse-battery",
  name: "E2E Admin",
} as const;

export const REGULAR_USER = {
  email: "e2e-user@example.test",
  password: "e2e-user-correct-horse-battery",
  name: "E2E User",
} as const;

export const ADMIN_ID_ENV = "E2E_ADMIN_USER_ID";
export const USER_ID_ENV = "E2E_REGULAR_USER_ID";
/** App password (Better Auth api key) for the admin, for header-auth requests. */
export const ADMIN_KEY_ENV = "E2E_API_KEY";
/** App password for the non-admin user. */
export const USER_KEY_ENV = "E2E_USER_API_KEY";

/**
 * Replayable session cookies, for the routes app passwords are refused on.
 *
 * An app password is scoped: it may not reach admin routes, /api/auth/*,
 * /api/app-passwords or /api/credentials. That is the point of the feature — a
 * credential on an e-reader must not be able to manage the account that issued
 * it — but it means a spec driving those routes has to authenticate the way a
 * browser does, not with a Bearer key.
 *
 * global-setup signs both accounts in to bootstrap the run and keeps the
 * cookies here rather than throwing them away.
 */
export const ADMIN_COOKIE_ENV = "E2E_ADMIN_COOKIE";
export const USER_COOKIE_ENV = "E2E_USER_COOKIE";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} not set — did global-setup.ts run?`);
  return value;
}

export function getAdminUserId(): string {
  return required(ADMIN_ID_ENV);
}

export function getRegularUserId(): string {
  return required(USER_ID_ENV);
}

/** The admin's session cookie, for routes that refuse app passwords. */
export function getAdminCookie(): string {
  return required(ADMIN_COOKIE_ENV);
}

/** The non-admin's session cookie. */
export function getUserCookie(): string {
  return required(USER_COOKIE_ENV);
}
