/**
 * E2E: the production configuration branch.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS FILE ONLY RUNS IN THE `prod-config` PROJECT, WHICH ONLY EXISTS WHEN
 * E2E_PROD_CONFIG=1. THE REST OF THE SUITE NEVER SEES IT.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Why it exists: every other E2E run boots the API with
 * `NODE_ENV=development`, because `bootstrap.ts` refuses `E2E_TEST=1` in
 * production and the support routes the suite depends on need that switch. So
 * a 150-test green suite only ever exercised the development side of every
 * `NODE_ENV` branch — `lib/auth.ts:trustedOrigins`, the KV/secondary-storage
 * split in `bootstrap.ts`, and the logger transport. "Production deployments
 * cannot sign in" was invisible to all of it.
 *
 * What this covers, and nothing more: an install configured the way a real
 * deployment is — `NODE_ENV=production`, no `E2E_TEST`, no `TEST_ROUTE_TOKEN`,
 * and `BETTER_AUTH_URL` set to the origin the browser actually drives.
 *
 * That last one is the crux. `trustedOrigins` is `[]` in production and Better
 * Auth resolves its trusted origin from `baseURL` ONCE, at startup — so an
 * absent or wrong `BETTER_AUTH_URL` does not fail to boot, it turns every
 * cookie-bearing POST into a 403 INVALID_ORIGIN. `env.ts` requires the variable
 * in production for exactly that reason. What nothing else can check is whether
 * the required value is SUFFICIENT, and the sign-out below is what proves it:
 * sign-out is a cookie-bearing POST, so the origin check runs on it in full.
 *
 * There are no support routes here, so this drives everything the way a person
 * would: first-run setup, sign out, sign in, replay the cookie.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SIGN-IN BUDGET: THIS FILE MAY PERFORM AT MOST TWO SIGN-INS. DO NOT ADD MORE.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Better Auth's own rate limiter is ON here, and only here. Every other E2E
 * harness sets `E2E_TEST=1`, which turns it off (`rateLimit.enabled` in
 * lib/auth.ts); this job deliberately does not, because the limiter running is
 * part of the production configuration under test. Its default rule for
 * `/sign-in*` is **3 requests per 10 seconds per IP** (better-auth
 * `getDefaultSpecialRules()`), and every test in this file shares one IP.
 *
 * A 429 does not surface as "rate limited". The SPA can only render it as a
 * generic failed login, so the run fails inside `signInThroughUi` with
 * `expect(page).not.toHaveURL(/\/login/)` timing out — pointing at the origin
 * check, which is fine, rather than at the limiter, which is the actual cause.
 * That is exactly how the first version of this file failed.
 *
 * The budget is kept by sharing ONE browser context across the whole serial
 * block instead of letting each test sign in for itself:
 *
 *   1. first-run setup            — the SPA signs the new admin in  (sign-in 1)
 *   2. sign-out + cookie replay   — reuses the session from (1)     (none)
 *   3. sign back in               — the point of the test           (sign-in 2)
 *   4. support routes absent      — no browser at all               (none)
 *
 * If you add a case that needs an authenticated browser, reuse `page` rather
 * than calling `signInThroughUi` again.
 */

import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, request as playwrightRequest } from "@playwright/test";
import { ADMIN } from "./helpers/accounts.js";
import { API_BASE, getSql } from "./helpers";
import { signInThroughUi, signOutThroughUi } from "./helpers/sign-in.js";

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

  // No retries, unlike the rest of the suite (playwright.config.ts sets 2 in
  // CI). A retry re-runs the whole serial block, so its two sign-ins land on
  // top of the previous attempt's — four inside the limiter's 10-second window.
  // The retry then 429s and reports "cannot sign in", which is indistinguishable
  // from the production regression this job exists to detect. A false P0 alarm
  // is worse than no retry: these four tests are deterministic, run against a
  // freshly emptied database, and finish in under ten seconds.
  test.describe.configure({ retries: 0 });

  // One context, one page, for the whole block — see the sign-in budget above.
  // browser.newContext() does NOT inherit the project's `use` options, so
  // baseURL has to be passed explicitly or a relative page.goto() never
  // resolves.
  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    await emptyTheInstall();
    context = await browser.newContext({
      baseURL: API_BASE,
      storageState: { cookies: [], origins: [] },
    });
    page = await context.newPage();
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test("an empty production install can be set up and signed into", async () => {
    const api = await anonymousApi();
    expect(await (await api.get(`${API_BASE}/api/setup`)).json()).toEqual({ required: true });
    await api.dispose();

    await page.goto("/login");
    await expect(page.getByTestId("setup-submit-btn")).toBeVisible();
    await page.getByTestId("setup-name-input").fill(ADMIN.name);
    await page.getByTestId("setup-email-input").fill(ADMIN.email);
    await page.getByTestId("setup-password-input").fill(ADMIN.password);
    // Sign-in 1 of 2: the setup form runs POST /api/setup and then signs the
    // new admin in through /api/auth/sign-in/email (see pages/login.vue).
    await page.getByTestId("setup-submit-btn").click();

    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
  });

  test("sign-out clears the origin check and revokes the session server-side", async () => {
    // Two claims in one test, deliberately: they need the same live session,
    // and signing in twice to separate them is what blew the budget before.
    //
    // Claim one is the production origin check. Sign-out is a cookie-bearing
    // POST, so Better Auth validates Origin against trustedOrigins in full —
    // which in production is resolved from BETTER_AUTH_URL alone. A 403
    // INVALID_ORIGIN leaves the browser sitting on /settings and this times out
    // on the URL.
    //
    // Claim two is that revocation is server-side. Capture the cookie while it
    // still works and replay it from outside the browser afterwards; a
    // client-only logout leaves a stolen cookie valid indefinitely.
    const header = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    expect(header, "the setup flow should have left a session cookie").not.toBe("");

    const api = await anonymousApi();
    // Prove the captured cookie works first, so the 401 below means "revoked"
    // rather than "never authenticated".
    expect((await api.get(`${API_BASE}/api/library`, { headers: { cookie: header } })).ok()).toBe(
      true,
    );

    await signOutThroughUi(page);

    await page.goto("/library");
    await expect(page).toHaveURL(/\/login/);

    expect(
      (await api.get(`${API_BASE}/api/library`, { headers: { cookie: header } })).status(),
    ).toBe(401);
    await api.dispose();
  });

  test("the admin can sign back in after signing out", async () => {
    // Sign-in 2 of 2, and the last one this file may spend. Setup signs you in
    // as a side effect, so this is the only place the ordinary sign-in form is
    // exercised against the production config.
    await signInThroughUi(page, ADMIN.email, ADMIN.password);
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
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
