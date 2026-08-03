/**
 * E2E: first-run setup, on a genuinely empty install.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS FILE RUNS LAST, IN ITS OWN PLAYWRIGHT PROJECT. DO NOT MERGE IT BACK.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * It calls /__test/cleanup { includeAuth: true }, which deletes every user,
 * session and app password and flushes Redis. Nothing that depends on the
 * accounts global-setup created can run afterwards: their ids are gone, their
 * app passwords are revoked, and the cookies in .auth/*.json are dead.
 *
 * It used to live at the bottom of auth.spec.ts, marked "Last, and serial".
 * That was the right intent with the wrong scope — last within one file, while
 * the file itself sorts FIRST in the suite. Every other spec then ran against a
 * world with no accounts in it, which is why the whole suite was red while each
 * spec passed alone.
 *
 * The `first-run` project in playwright.config.ts declares
 * `dependencies: ["chromium"]`, so Playwright will not start it until the main
 * project has finished. That ordering is the only thing keeping this safe —
 * if you move these tests, take the project with them.
 */

import { test, expect, request as playwrightRequest } from "@playwright/test";
import { ADMIN, REGULAR_USER } from "./helpers/accounts.js";
import { API_BASE } from "./helpers";
import { signInThroughUi } from "./helpers/sign-in.js";

/** A context with no cookies — a first-run visitor has none by definition. */
test.use({ storageState: { cookies: [], origins: [] } });

async function anonymousApi() {
  return await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] } });
}

test.describe.serial("first-run setup", () => {
  test("offers setup on an empty install, then closes for good", async ({ page }) => {
    const api = await anonymousApi();
    await api.post(`${API_BASE}/__test/cleanup`, { data: { includeAuth: true } });

    expect(await (await api.get(`${API_BASE}/api/setup`)).json()).toEqual({ required: true });

    await page.goto("/login");
    await expect(page.getByTestId("auth-layout")).toBeVisible();
    await expect(page.getByTestId("setup-intro")).toBeVisible();
    await expect(page.getByTestId("setup-submit-btn")).toBeVisible();

    await page.getByTestId("setup-name-input").fill(ADMIN.name);
    await page.getByTestId("setup-email-input").fill(ADMIN.email);
    await page.getByTestId("setup-password-input").fill(ADMIN.password);
    await page.getByTestId("setup-submit-btn").click();

    // Setup signs the new admin straight in — no second form to fill.
    await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();

    // And it cannot be used again to mint a second admin. This is the only
    // guard on a route that has to be public — nobody can authenticate on a
    // fresh install — so it is the whole security of first-run setup.
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

    // The admin can create the household's other accounts, which is the point
    // of being one: self-registration is disabled outright, so this is the only
    // way anybody else gets in.
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
