/**
 * Playwright auth setup — admin session, captured by signing in for real.
 *
 * This drives the actual login page rather than POSTing to an endpoint and
 * hand-parsing Set-Cookie, which is what the previous version did: it
 * hardcoded the cookie name and sameSite, so a change to either produced a
 * suite that authenticated itself in a way no browser ever would.
 *
 * Signing in through the UI also means every run smoke-tests the sign-in flow
 * before a single spec executes — if login breaks, the failure says so.
 */

import { mkdirSync } from "node:fs";
import { test as setup, expect } from "@playwright/test";
import { ADMIN } from "./helpers/accounts.js";
import { signInThroughUi } from "./helpers/sign-in.js";

const AUTH_FILE = ".auth/user.json";

setup("authenticate admin", async ({ page }) => {
  await signInThroughUi(page, ADMIN.email, ADMIN.password);

  // Landed inside the app, not back on the login page.
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible({ timeout: 10_000 });

  mkdirSync(".auth", { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
