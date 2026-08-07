/**
 * E2E: the production configuration branch.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS FILE ONLY RUNS IN THE `prod-config` PROJECT, WHICH ONLY EXISTS WHEN
 * E2E_PROD_CONFIG=1. THE REST OF THE SUITE NEVER SEES IT.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Why it exists (libris-59m.11): every other E2E run boots the API with
 * `NODE_ENV=development`, because `bootstrap.ts` refuses `E2E_TEST=1` in
 * production and the support routes the suite depends on need that switch. So
 * a 150-test green suite only ever exercised the development side of every
 * `NODE_ENV` branch — `lib/auth.ts:trustedOrigins`, the KV/secondary-storage
 * split in `bootstrap.ts`, and the logger transport. "Production deployments
 * cannot sign in" was invisible to all of it.
 *
 * What this covers, and nothing more: an install configured the way a real
 * deployment is — `NODE_ENV=production`, no `E2E_TEST`, no
 * `TEST_ROUTE_TOKEN`, and **no `BETTER_AUTH_URL`**, which is the documented
 * default for a container behind a TLS-terminating proxy that cannot know its
 * own public URL. That last one is the point: with it unset, Better Auth has to
 * derive its trusted origin from the request, and `trustedOrigins` being empty
 * in production is precisely what turns every cookie-bearing POST into a 403
 * INVALID_ORIGIN.
 *
 * There are no support routes here, so this drives everything the way a person
 * would: first-run setup, sign out, sign in, replay the cookie.
 */

import { test, expect, request as playwrightRequest } from "@playwright/test";
import { ADMIN } from "./helpers/accounts.js";
import { API_BASE, getSql } from "./helpers";
import { signInThroughUi, signOutThroughUi } from "./helpers/sign-in.js";

test.use({ storageState: { cookies: [], origins: [] } });

async function anonymousApi() {
  return await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] } });
}

/**
 * Empty the install. There are no support routes here, so this goes straight to
 * Postgres.
 *
 * In a serial group Playwright restarts from the first test on retry, and the
 * first test needs a users table with nothing in it — without this, a retry
 * finds the admin from the previous attempt, `GET /api/setup` answers
 * `required: false`, and the failure reads as a missing setup form rather than
 * whatever actually went wrong.
 */
async function emptyTheInstall(): Promise<void> {
  const sql = getSql();
  try {
    await sql`DELETE FROM sessions`;
    await sql`DELETE FROM api_keys`;
    await sql`DELETE FROM accounts`;
    await sql`DELETE FROM verifications`;
    await sql`DELETE FROM users`;
    // The bootstrap lease lives here; leaving it makes POST /api/setup 409.
    await sql`DELETE FROM app_settings`;
  } finally {
    await sql.end();
  }
}

test.describe.serial("production configuration", () => {
  test.slow();

  test.beforeAll(emptyTheInstall);

  test("an empty production install can be set up and signed into", async ({ page }) => {
    const api = await anonymousApi();
    expect(await (await api.get(`${API_BASE}/api/setup`)).json()).toEqual({ required: true });
    await api.dispose();

    await page.goto("/login");
    await expect(page.getByTestId("setup-submit-btn")).toBeVisible();
    await page.getByTestId("setup-name-input").fill(ADMIN.name);
    await page.getByTestId("setup-email-input").fill(ADMIN.email);
    await page.getByTestId("setup-password-input").fill(ADMIN.password);
    await page.getByTestId("setup-submit-btn").click();

    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
  });

  test("signing out and back in works against the production origin check", async ({ page }) => {
    // The assertion that fails when production's trustedOrigins cannot resolve:
    // sign-out is a cookie-bearing POST, so Better Auth's origin check runs on
    // it in full. A 403 INVALID_ORIGIN leaves the browser on /settings and this
    // times out on the URL.
    await signInThroughUi(page, ADMIN.email, ADMIN.password);
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();

    await signOutThroughUi(page);

    await page.goto("/library");
    await expect(page).toHaveURL(/\/login/);

    await signInThroughUi(page, ADMIN.email, ADMIN.password);
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
  });

  test("sign-out revokes the session server-side, not just in the browser", async ({ page }) => {
    await signInThroughUi(page, ADMIN.email, ADMIN.password);
    const header = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");

    // Prove the captured cookie works first, so the 401 below means "revoked"
    // rather than "never authenticated".
    const api = await anonymousApi();
    expect((await api.get(`${API_BASE}/api/library`, { headers: { cookie: header } })).ok()).toBe(
      true,
    );

    await signOutThroughUi(page);

    expect(
      (await api.get(`${API_BASE}/api/library`, { headers: { cookie: header } })).status(),
    ).toBe(401);
    await api.dispose();
  });

  test("the support routes are not mounted in production", async () => {
    // The other half of the contract: E2E_TEST is off here, so /__test/* must
    // not exist at all. If it answered, this job would be testing the same
    // relaxed build as every other shard.
    const api = await anonymousApi();
    const res = await api.post(`${API_BASE}/__test/invalidate-cache`);
    expect([401, 404]).toContain(res.status());
    await api.dispose();
  });
});
