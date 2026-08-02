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
