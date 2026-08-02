/**
 * Playwright auth setup — non-admin session.
 *
 * Same real sign-in as the admin setup; see auth.setup.ts for why this goes
 * through the UI rather than forging a cookie.
 */

import { mkdirSync } from "node:fs";
import { test as setup, expect } from "@playwright/test";
import { REGULAR_USER } from "./helpers/accounts.js";
import { signInThroughUi } from "./helpers/sign-in.js";

const AUTH_FILE = ".auth/regular-user.json";

setup("authenticate regular user", async ({ page }) => {
  await signInThroughUi(page, REGULAR_USER.email, REGULAR_USER.password);

  await expect(page.getByRole("link", { name: "Home" })).toBeVisible({ timeout: 10_000 });

  mkdirSync(".auth", { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
