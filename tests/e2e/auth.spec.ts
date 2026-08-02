/**
 * E2E: the whole auth surface, front to back (libris-5ng.24).
 *
 * These drive a real browser against a real API and a real Postgres. Unit and
 * integration tests cover the pieces; what only this level can catch is the
 * seam — cookie attributes a browser actually honours, the router guard and
 * the server agreeing on who is signed in, and a credential minted in the UI
 * working against the API an e-reader would call.
 *
 * Organised by flow. Edge cases sit next to the flow they belong to rather
 * than in a bucket at the end.
 */

import {
  test,
  expect,
  request as playwrightRequest,
  type Browser,
  type Page,
} from "@playwright/test";
import { ADMIN, REGULAR_USER } from "./helpers/accounts.js";
import { API_BASE, getApiKey, getUserApiKey } from "./helpers";
import { signInThroughUi } from "./helpers/sign-in.js";

/** A context with no cookies, for testing the signed-out world. */
const ANONYMOUS = { storageState: { cookies: [], origins: [] } };

/**
 * An API context that is genuinely anonymous.
 *
 * request.newContext() inherits the project's `use` options, storageState
 * included — so a plain newContext() inside the chromium project arrives
 * carrying the suite's admin session. Every "should be 401" assertion below
 * would then be testing an authenticated request, and the dangerous version of
 * that mistake is an assertion that still passes for the wrong reason.
 */
/**
 * A second signed-out browser, for "can this other person get in" checks.
 *
 * browser.newContext() does NOT inherit the project's `use` options — that is
 * the `context` fixture's job — so baseURL has to be passed explicitly or a
 * relative page.goto() never resolves.
 */
async function freshContext(browser: Browser) {
  return await browser.newContext({
    baseURL: `http://localhost:${process.env.CI ? 3000 : 3100}`,
    storageState: { cookies: [], origins: [] },
  });
}

async function anonymousApi() {
  return await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] } });
}

async function expectOnLoginPage(page: Page) {
  await expect(page.getByTestId("login-page")).toBeVisible();
  await expect(page.getByTestId("login-submit-btn")).toBeVisible();
}

async function fillSignIn(page: Page, email: string, password: string) {
  await page.getByTestId("login-email-input").fill(email);
  await page.getByTestId("login-password-input").fill(password);
  await page.getByTestId("login-submit-btn").click();
}

// ── Sign-in ──────────────────────────────────────────────────────────

test.describe("sign-in", { tag: "@smoke" }, () => {
  test.use(ANONYMOUS);

  test("signs in with email and password and lands in the app", async ({ page }) => {
    await signInThroughUi(page, ADMIN.email, ADMIN.password);
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
  });

  test("rejects a wrong password without confirming the account exists", async ({ page }) => {
    await page.goto("/login");
    await fillSignIn(page, ADMIN.email, "not-the-password");

    const error = page.getByTestId("login-error");
    await expect(error).toBeVisible();
    await expect(error).toContainText(/invalid email or password/i);
    await expectOnLoginPage(page);
  });

  test("says exactly the same thing for an unknown address", async ({ page }) => {
    // Account enumeration: if a wrong password and an unknown address produced
    // different text, this form would tell an attacker who has an account here.
    await page.goto("/login");
    await fillSignIn(page, "nobody@example.test", ADMIN.password);

    await expect(page.getByTestId("login-error")).toContainText(/invalid email or password/i);
  });

  test("clears the password field after a failed attempt", async ({ page }) => {
    await page.goto("/login");
    await fillSignIn(page, ADMIN.email, "wrong");

    await expect(page.getByTestId("login-error")).toBeVisible();
    await expect(page.getByTestId("login-password-input")).toHaveValue("");
  });

  test("will not submit a malformed email", async ({ page }) => {
    await page.goto("/login");
    await fillSignIn(page, "not-an-email", ADMIN.password);

    await expectOnLoginPage(page);
    await expect(page.getByText(/valid email address/i)).toBeVisible();
  });

  test("does not offer self-registration anywhere", async ({ page }) => {
    // Accounts are admin-created. A sign-up link would be a promise the server
    // refuses to keep — POST /api/auth/sign-up/email is disabled outright.
    await page.goto("/login");
    await expect(page.getByText(/sign up|create an account|register/i)).toHaveCount(0);
    await expect(page.getByTestId("password-reset-note")).toContainText(/admin/i);
  });

  test("the sign-up endpoint stays shut even when called directly", async () => {
    const api = await anonymousApi();
    const res = await api.post(`${API_BASE}/api/auth/sign-up/email`, {
      data: { email: "stranger@example.test", password: "stranger-password", name: "Stranger" },
    });
    expect(res.ok()).toBe(false);
    await api.dispose();
  });
});

// ── Where you land afterwards ────────────────────────────────────────

test.describe("post-sign-in redirect", () => {
  test.use(ANONYMOUS);

  test("sends an anonymous visitor to /login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
    await expectOnLoginPage(page);
  });

  test("returns the user to the page they asked for", async ({ page }) => {
    await page.goto("/library");
    await expect(page).toHaveURL(/\/login\?redirect=/);

    await fillSignIn(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/library$/);
  });

  test("keeps the query string of a deep link", async ({ page }) => {
    await page.goto("/library?search=dune");
    await expect(page).toHaveURL(/\/login\?redirect=/);

    await fillSignIn(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/library\?search=dune/);
  });

  test("refuses to be redirected off-site after sign-in", async ({ page }) => {
    // Open redirect: without the guard in utils/redirect.ts, signing in here
    // hands the user straight to an attacker's copy of the login page.
    await page.goto("/login?redirect=https://libris-phish.example/steal");
    await fillSignIn(page, ADMIN.email, ADMIN.password);

    await expect(page).not.toHaveURL(/\/login/);
    expect(page.url()).toContain("localhost");
    expect(page.url()).not.toContain("libris-phish.example");
  });

  test("refuses a protocol-relative redirect too", async ({ page }) => {
    await page.goto("/login?redirect=//libris-phish.example");
    await fillSignIn(page, ADMIN.email, ADMIN.password);

    await expect(page).not.toHaveURL(/\/login/);
    expect(page.url()).toContain("localhost");
  });
});

// ── Session lifetime ─────────────────────────────────────────────────

test.describe("session", () => {
  test("survives a full page reload", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
    expect(new URL(page.url()).pathname).not.toBe("/login");
  });

  test("is stored in an httpOnly cookie that scripts cannot read", async ({ page }) => {
    // If the session cookie were readable from JavaScript, any XSS anywhere in
    // the app would be a full account takeover rather than a contained bug.
    await page.goto("/");
    const cookies = await page.context().cookies();
    const sessionCookies = cookies.filter((c) => c.name.includes("session"));

    expect(sessionCookies.length).toBeGreaterThan(0);
    for (const cookie of sessionCookies) {
      expect(cookie.httpOnly, `${cookie.name} must be httpOnly`).toBe(true);
      expect(cookie.sameSite, `${cookie.name} must not be sameSite=None`).not.toBe("None");
    }

    expect(await page.evaluate(() => document.cookie)).not.toContain("session_token");
  });

  // Signing out revokes the session SERVER-side, so these two tests each sign
  // in freshly rather than sharing the suite's stored session — otherwise the
  // first to run invalidates the cookie the second starts with, and the second
  // fails on a missing logout button three assertions later.
  test.describe("signing out", () => {
    test.use(ANONYMOUS);

    test("sends you to the login page and keeps you there", async ({ page }) => {
      await signInThroughUi(page, ADMIN.email, ADMIN.password);

      await page.goto("/settings");
      await page.getByTestId("logout-btn").click();
      await expect(page).toHaveURL(/\/login/);

      await page.goto("/library");
      await expect(page).toHaveURL(/\/login/);
    });

    test("revokes the session server-side, not just in the browser", async ({ page }) => {
      // Capture the cookie, sign out, then replay it from outside the browser.
      // A client-only logout leaves a stolen cookie working indefinitely.
      await signInThroughUi(page, ADMIN.email, ADMIN.password);
      const header = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");

      // Prove the captured cookie works before revoking it, so a 401 afterwards
      // means "revoked" and not "never authenticated".
      const api = await anonymousApi();
      expect((await api.get(`${API_BASE}/api/library`, { headers: { cookie: header } })).ok()).toBe(
        true,
      );

      await page.goto("/settings");
      await page.getByTestId("logout-btn").click();
      await expect(page).toHaveURL(/\/login/);

      const after = await api.get(`${API_BASE}/api/library`, { headers: { cookie: header } });
      expect(after.status()).toBe(401);
      await api.dispose();
    });
  });
});

// ── Authorization ────────────────────────────────────────────────────

test.describe("authorization", () => {
  test("a non-admin cannot reach an admin-only endpoint", async () => {
    const api = await anonymousApi();
    const res = await api.get(`${API_BASE}/api/jobs/status`, {
      headers: { Authorization: `Bearer ${getUserApiKey()}` },
    });
    expect(res.status()).toBe(403);
    await api.dispose();
  });

  test("an admin can", async () => {
    const api = await anonymousApi();
    const res = await api.get(`${API_BASE}/api/jobs/status`, {
      headers: { Authorization: `Bearer ${getApiKey()}` },
    });
    expect(res.ok()).toBe(true);
    await api.dispose();
  });

  test("no credential is 401, not 403", async () => {
    // 403 means "we know who you are and you may not"; the honest answer to an
    // anonymous caller is "who are you".
    const api = await anonymousApi();
    expect((await api.get(`${API_BASE}/api/library`)).status()).toBe(401);
    await api.dispose();
  });

  test("a bogus credential is 401, not a 500", async () => {
    // getSession THROWS for a presented-but-rejected credential, so without the
    // catch in authMiddleware this is a server error that pages the on-call.
    const api = await anonymousApi();
    const res = await api.get(`${API_BASE}/api/library`, {
      headers: { Authorization: "Bearer not-a-real-key-at-all" },
    });
    expect(res.status()).toBe(401);
    await api.dispose();
  });
});

// ── App passwords, end to end ────────────────────────────────────────

test.describe("app passwords", () => {
  test("a credential the API issues works in every header form a client uses", async () => {
    // The point of the feature: one credential, whether it arrives from an
    // OPDS reader (Basic), a script (Bearer) or the plugin's own header.
    const api = await anonymousApi();
    const created = await api.post(`${API_BASE}/api/app-passwords`, {
      headers: { Authorization: `Bearer ${getApiKey()}` },
      data: { name: "every-header" },
    });
    expect(created.status()).toBe(201);
    const { key } = (await created.json()) as { key: string };

    const headerForms: Record<string, string>[] = [
      { Authorization: `Bearer ${key}` },
      { "x-api-key": key },
      { Authorization: `Basic ${Buffer.from(`${ADMIN.email}:${key}`).toString("base64")}` },
    ];
    for (const headers of headerForms) {
      const res = await api.get(`${API_BASE}/api/library`, { headers });
      expect(res.ok(), `failed for ${JSON.stringify(Object.keys(headers))}`).toBe(true);
    }
    await api.dispose();
  });

  test("revoking one stops it working immediately", async () => {
    // Nothing caches in the auth path, so "immediately" should be literal.
    const api = await anonymousApi();
    const created = await api.post(`${API_BASE}/api/app-passwords`, {
      headers: { Authorization: `Bearer ${getApiKey()}` },
      data: { name: "revoke-me" },
    });
    const { id, key } = (await created.json()) as { id: string; key: string };

    expect((await api.get(`${API_BASE}/api/library`, { headers: { "x-api-key": key } })).ok()).toBe(
      true,
    );

    const deleted = await api.delete(`${API_BASE}/api/app-passwords/${id}`, {
      headers: { Authorization: `Bearer ${getApiKey()}` },
    });
    expect(deleted.status()).toBe(204);

    expect(
      (await api.get(`${API_BASE}/api/library`, { headers: { "x-api-key": key } })).status(),
    ).toBe(401);
    await api.dispose();
  });

  test("one user cannot revoke another's, and cannot learn it exists", async () => {
    const api = await anonymousApi();
    const created = await api.post(`${API_BASE}/api/app-passwords`, {
      headers: { Authorization: `Bearer ${getApiKey()}` },
      data: { name: "admin-only" },
    });
    const { id, key } = (await created.json()) as { id: string; key: string };

    const res = await api.delete(`${API_BASE}/api/app-passwords/${id}`, {
      headers: { Authorization: `Bearer ${getUserApiKey()}` },
    });
    // 404 rather than 403: 403 would confirm the id is real.
    expect(res.status()).toBe(404);
    expect((await api.get(`${API_BASE}/api/library`, { headers: { "x-api-key": key } })).ok()).toBe(
      true,
    );
    await api.dispose();
  });

  test("the list shows only your own, and never the plaintext", async () => {
    const api = await anonymousApi();
    const listed = await api.get(`${API_BASE}/api/app-passwords`, {
      headers: { Authorization: `Bearer ${getUserApiKey()}` },
    });
    const { keys } = (await listed.json()) as { keys: Record<string, unknown>[] };

    expect(keys.every((k) => k.name !== "e2e-admin-key")).toBe(true);
    for (const entry of keys) {
      expect(entry).not.toHaveProperty("key");
    }
    await api.dispose();
  });

  test("an anonymous caller cannot mint one", async () => {
    const api = await anonymousApi();
    const res = await api.post(`${API_BASE}/api/app-passwords`, { data: { name: "sneaky" } });
    expect(res.status()).toBe(401);
    await api.dispose();
  });
});

// ── The app-passwords UI ─────────────────────────────────────────────

test.describe("app passwords in the UI", () => {
  test("creates one, reveals it exactly once, and it actually works", async ({ page }) => {
    // The end-to-end claim of the whole feature: what the settings page hands
    // you must authenticate a real request. Minting it in the browser and
    // spending it outside the browser is the only way to prove both halves.
    await page.goto("/settings");

    await page.getByTestId("field-new-key-label").fill("E2E Kobo");
    await page.getByTestId("create-key-btn").click();

    const reveal = page.getByTestId("new-key-value");
    await expect(reveal).toBeVisible();
    const key = (await reveal.textContent())?.trim() ?? "";
    expect(key.length).toBeGreaterThan(10);

    const api = await anonymousApi();
    expect((await api.get(`${API_BASE}/api/library`, { headers: { "x-api-key": key } })).ok()).toBe(
      true,
    );
    await api.dispose();

    // Dismiss and reload: the plaintext must be gone for good, not merely hidden.
    await page.getByTestId("dismiss-new-key-btn").click();
    await page.reload();
    await expect(page.getByTestId("new-key-value")).toHaveCount(0);
    await expect(page.getByText(key, { exact: false })).toHaveCount(0);
  });

  test("lists it, then revokes it and the credential stops working", async ({ page }) => {
    const api = await anonymousApi();
    const created = await api.post(`${API_BASE}/api/app-passwords`, {
      headers: { Authorization: `Bearer ${getApiKey()}` },
      data: { name: "E2E Revoke Me" },
    });
    const { id, key } = (await created.json()) as { id: string; key: string };

    await page.goto("/settings");
    const row = page.getByTestId(`api-key-item-${id}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText("E2E Revoke Me");

    await page.getByTestId(`delete-key-btn-${id}`).click();
    await page.getByTestId("confirm-delete-key-btn").click();

    await expect(row).toHaveCount(0);
    expect(
      (await api.get(`${API_BASE}/api/library`, { headers: { "x-api-key": key } })).status(),
    ).toBe(401);
    await api.dispose();
  });

  test("a non-admin manages their own without an admin tab in sight", async ({ browser }) => {
    // Credentials stopped being an admin concern when a credential stopped
    // being a person. A regular user must be able to connect their own reader.
    const context = await browser.newContext({
      baseURL: `http://localhost:${process.env.CI ? 3000 : 3100}`,
      storageState: ".auth/regular-user.json",
    });
    const page = await context.newPage();

    await page.goto("/settings");
    await expect(page.getByTestId("field-new-key-label")).toBeVisible();

    await page.getByTestId("field-new-key-label").fill("Regular User Kobo");
    await page.getByTestId("create-key-btn").click();

    const key = (await page.getByTestId("new-key-value").textContent())?.trim() ?? "";
    const api = await anonymousApi();
    expect((await api.get(`${API_BASE}/api/library`, { headers: { "x-api-key": key } })).ok()).toBe(
      true,
    );
    // ...and it is still only a user: the credential carries their role, not more.
    expect(
      (await api.get(`${API_BASE}/api/jobs/status`, { headers: { "x-api-key": key } })).status(),
    ).toBe(403);

    await api.dispose();
    await context.close();
  });

  test("shows the reader setup hints next to the credentials", async ({ page }) => {
    // A password with no server URL is half an answer; both live on one screen.
    await page.goto("/settings");
    await expect(page.getByTestId("opds-url")).toBeVisible();
    await expect(page.getByTestId("kosync-url")).toBeVisible();
    await expect(page.getByTestId("opds-app-password-hint")).toBeVisible();
  });
});

// ── OPDS, which is why Basic auth exists at all ──────────────────────

test.describe("OPDS", () => {
  test("challenges an anonymous reader so it prompts for credentials", async () => {
    // Without WWW-Authenticate, KOReader shows an error instead of a login box
    // and the user concludes Libris is broken.
    const api = await anonymousApi();
    const res = await api.get(`${API_BASE}/opds`);
    expect(res.status()).toBe(401);
    expect(res.headers()["www-authenticate"]).toMatch(/^Basic realm=/i);
    await api.dispose();
  });

  test("does not challenge on a normal API route", async () => {
    // A browser fetch that receives this header pops the native Basic dialog
    // over the SPA, which is the wrong way to ask someone to sign in.
    const api = await anonymousApi();
    const res = await api.get(`${API_BASE}/api/library`);
    expect(res.status()).toBe(401);
    expect(res.headers()["www-authenticate"]).toBeUndefined();
    await api.dispose();
  });

  test("serves the catalog to an app password over Basic", async () => {
    const api = await anonymousApi();
    const res = await api.get(`${API_BASE}/opds`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${ADMIN.email}:${getApiKey()}`).toString("base64")}`,
      },
    });
    expect(res.ok()).toBe(true);
    expect(res.headers()["content-type"]).toContain("xml");
    await api.dispose();
  });

  test("rejects the key sent as the Basic username", async () => {
    // The old extractKey accepted this. It is gone on purpose: it made one
    // string a secret in one position and a public identifier in the other.
    // Anonymous context: a leaked session cookie would authenticate the request
    // by another route and hide the rejection this asserts.
    const api = await anonymousApi();
    const res = await api.get(`${API_BASE}/opds`, {
      headers: { Authorization: `Basic ${Buffer.from(`${getApiKey()}:`).toString("base64")}` },
    });
    expect(res.status()).toBe(401);
    await api.dispose();
  });

  test("survives more requests than the plugin's default daily budget", async () => {
    // The apiKey plugin defaults to 10 requests per DAY per key. Browsing a
    // catalog spends that before the reader has drawn anything, and the
    // rejection arrives as a 401 — indistinguishable from a wrong password.
    const api = await anonymousApi();
    const auth = {
      Authorization: `Basic ${Buffer.from(`${ADMIN.email}:${getApiKey()}`).toString("base64")}`,
    };
    for (let i = 0; i < 15; i++) {
      expect((await api.get(`${API_BASE}/opds`, { headers: auth })).ok(), `request ${i + 1}`).toBe(
        true,
      );
    }
    await api.dispose();
  });
});

// ── Admin user management ────────────────────────────────────────────

// Serial and stateful on purpose: these walk one account through its life —
// created, promoted, password reset, banned, demoted. Splitting them into
// independent tests would mean re-creating the account five times and would
// stop them covering the transitions, which is where the bugs live.
test.describe.serial("user management", () => {
  // Each of these opens a second browser context and signs in through it, on a
  // Vite dev server that compiles on demand. Two full page loads plus a
  // sign-in does not fit the 30s default.
  test.slow();

  const NEW_USER = {
    name: "Housemate",
    email: "housemate@example.test",
    password: "housemate-correct-horse",
  };

  test("an admin creates an account that can actually sign in", async ({ page, browser }) => {
    // Self-registration is off, so this page is the ONLY way a second person
    // gets in. "Created" is worth nothing unless they can then sign in.
    await page.goto("/settings");
    await page.getByRole("tab", { name: "Users" }).click();
    await expect(page.getByTestId("users-panel")).toBeVisible();

    await page.getByTestId("new-user-name").fill(NEW_USER.name);
    await page.getByTestId("new-user-email").fill(NEW_USER.email);
    await page.getByTestId("new-user-password").fill(NEW_USER.password);
    await page.getByTestId("create-user-btn").click();

    // Scope to the list: the success toast also contains the address, and a
    // bare getByText matches both.
    await expect(
      page.locator('[data-testid^="user-item-"]', { hasText: NEW_USER.email }),
    ).toBeVisible();

    const context = await freshContext(browser);
    const fresh = await context.newPage();
    await signInThroughUi(fresh, NEW_USER.email, NEW_USER.password);
    await expect(fresh.getByRole("link", { name: "Home" })).toBeVisible();
    await context.close();
  });

  test("a new account is not an admin", async ({ browser }) => {
    const context = await freshContext(browser);
    const fresh = await context.newPage();
    await signInThroughUi(fresh, NEW_USER.email, NEW_USER.password);

    // No Users tab for them...
    await fresh.goto("/settings");
    await expect(fresh.getByRole("tab", { name: "Users" })).toHaveCount(0);

    // ...and the endpoint refuses them too, which is the gate that matters.
    const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");
    const api = await anonymousApi();
    const res = await api.get(`${API_BASE}/api/auth/admin/list-users?limit=10`, {
      headers: { cookie },
    });
    expect(res.ok()).toBe(false);
    await api.dispose();
    await context.close();
  });

  test("promoting takes effect on the promoted user's existing session", async ({
    page,
    browser,
  }) => {
    // The trap this pins: a session is a SNAPSHOT in secondary storage, so a
    // role written straight to the database is invisible until the user signs
    // in again. Going through the admin plugin refreshes it — if that ever
    // regresses, the UI reports a promotion that has not happened.
    const context = await freshContext(browser);
    const fresh = await context.newPage();
    await signInThroughUi(fresh, NEW_USER.email, NEW_USER.password);
    const cookie = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join("; ");

    const api = await anonymousApi();
    expect((await api.get(`${API_BASE}/api/jobs/status`, { headers: { cookie } })).status()).toBe(
      403,
    );

    await page.goto("/settings");
    await page.getByRole("tab", { name: "Users" }).click();
    const row = page.locator('[data-testid^="user-item-"]', { hasText: NEW_USER.email });
    await row.getByRole("button", { name: "Make admin" }).click();
    await expect(row.getByTestId("role-badge-admin")).toBeVisible();

    // Same cookie, no re-sign-in.
    expect((await api.get(`${API_BASE}/api/jobs/status`, { headers: { cookie } })).ok()).toBe(true);

    await api.dispose();
    await context.close();
  });

  test("an admin can set someone's password, which is the only recovery path", async ({
    page,
    browser,
  }) => {
    const RESET = "reset-by-the-admin-9999";

    await page.goto("/settings");
    await page.getByRole("tab", { name: "Users" }).click();
    const row = page.locator('[data-testid^="user-item-"]', { hasText: NEW_USER.email });
    await row.getByRole("button", { name: "Set password" }).click();

    await page.getByTestId("set-password-input").fill(RESET);
    await page.getByTestId("confirm-set-password-btn").click();
    await expect(page.getByTestId("set-password-input")).toHaveCount(0);

    const context = await freshContext(browser);
    const fresh = await context.newPage();
    await signInThroughUi(fresh, NEW_USER.email, RESET);
    await expect(fresh.getByRole("link", { name: "Home" })).toBeVisible();
    await context.close();
  });

  test("banning stops the account signing in, and unbanning restores it", async ({
    page,
    browser,
  }) => {
    await page.goto("/settings");
    await page.getByRole("tab", { name: "Users" }).click();
    const row = page.locator('[data-testid^="user-item-"]', { hasText: NEW_USER.email });

    await row.getByRole("button", { name: "Ban" }).click();
    await expect(row.getByText("Banned")).toBeVisible();

    const context = await freshContext(browser);
    const banned = await context.newPage();
    await banned.goto("/login");
    await banned.getByTestId("login-email-input").fill(NEW_USER.email);
    await banned.getByTestId("login-password-input").fill("reset-by-the-admin-9999");
    await banned.getByTestId("login-submit-btn").click();
    await expect(banned.getByTestId("login-error")).toBeVisible();
    await expect(banned).toHaveURL(/\/login/);
    await context.close();

    await row.getByRole("button", { name: "Unban" }).click();
    await expect(row.getByText("Banned")).toHaveCount(0);
  });

  test("the last admin cannot be demoted out of existence", async ({ page }) => {
    // One click should not be able to lock the household out of user
    // management with SQL as the only way back.
    await page.goto("/settings");
    await page.getByRole("tab", { name: "Users" }).click();

    const adminRow = page.locator('[data-testid^="user-item-"]', { hasText: ADMIN.email });
    // The seeded housemate was promoted earlier in this file, so demote them
    // first to get down to a single admin.
    const other = page.locator('[data-testid^="user-item-"]', { hasText: NEW_USER.email });
    const demote = other.getByRole("button", { name: "Make user" });
    if (await demote.isEnabled().catch(() => false)) await demote.click();
    await expect(other.getByTestId("role-badge-admin")).toHaveCount(0);

    await expect(adminRow.getByRole("button", { name: "Make user" })).toBeDisabled();
  });
});

// ── First-run setup ──────────────────────────────────────────────────
//
// Last, and serial: it empties the users table, which invalidates every other
// spec's session. The accounts are rebuilt before it finishes.

test.describe.serial("first-run setup", () => {
  test.use(ANONYMOUS);

  test("offers setup on an empty install, then closes for good", async ({ page }) => {
    const api = await anonymousApi();
    await api.post(`${API_BASE}/__test/cleanup`, { data: { includeAuth: true } });

    expect(await (await api.get(`${API_BASE}/api/setup`)).json()).toEqual({ required: true });

    await page.goto("/login");
    await expect(page.getByTestId("setup-intro")).toBeVisible();
    await expect(page.getByTestId("setup-submit-btn")).toBeVisible();

    await page.getByTestId("setup-name-input").fill(ADMIN.name);
    await page.getByTestId("setup-email-input").fill(ADMIN.email);
    await page.getByTestId("setup-password-input").fill(ADMIN.password);
    await page.getByTestId("setup-submit-btn").click();

    // Setup signs the new admin straight in — no second form to fill.
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();

    // And it cannot be used again to mint a second admin.
    const second = await api.post(`${API_BASE}/api/setup`, {
      data: { email: "intruder@example.test", password: "intruder-password", name: "Intruder" },
    });
    expect(second.status()).toBe(409);
    expect(await (await api.get(`${API_BASE}/api/setup`)).json()).toEqual({ required: false });
    await api.dispose();
  });

  test("the first account really is an admin", async ({ page }) => {
    await signInThroughUi(page, ADMIN.email, ADMIN.password);
    const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("; ");

    const api = await anonymousApi();
    // An admin-only endpoint is the honest test of the role — the setup route
    // claims to create an admin, and this is what that claim has to mean.
    expect((await api.get(`${API_BASE}/api/jobs/status`, { headers: { cookie } })).ok()).toBe(true);

    // Rebuild the regular user the rest of the suite expects — the cleanup
    // above removed it, and the storageState files still reference it.
    const res = await api.post(`${API_BASE}/api/auth/admin/create-user`, {
      headers: { cookie, Origin: API_BASE },
      data: {
        email: REGULAR_USER.email,
        password: REGULAR_USER.password,
        name: REGULAR_USER.name,
        role: "user",
      },
    });
    expect(res.ok(), await res.text()).toBe(true);
    await api.dispose();
  });
});
