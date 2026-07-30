import { test as base, expect, type Page, type BrowserContext } from "@playwright/test";

/**
 * Extended Playwright fixtures with pre-authenticated page contexts for
 * both admin and regular (non-admin) users.
 *
 * - `authedPage` / `adminPage`: uses `.auth/user.json` (admin session)
 * - `userPage`: uses `.auth/regular-user.json` (non-admin session)
 *
 * Authentication state is loaded from storageState files populated by
 * the auth setup projects (auth.setup.ts and user-auth.setup.ts).
 */
export const test = base.extend<{
  authedPage: Page;
  adminPage: Page;
  userPage: Page;
  livePage: Page;
}>({
  authedPage: async ({ page }, use) => {
    // Disable the app-wide websocket singleton so networkidle-based tests can settle.
    await page.addInitScript(() => {
      (
        window as Window & { __LIBRIS_DISABLE_SERVER_EVENTS__?: boolean }
      ).__LIBRIS_DISABLE_SERVER_EVENTS__ = true;
    });

    await page.goto("/");
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
    await use(page);
  },

  adminPage: async ({ page }, use) => {
    // adminPage is an alias for authedPage — same admin storageState from chromium project.
    await page.addInitScript(() => {
      (
        window as Window & { __LIBRIS_DISABLE_SERVER_EVENTS__?: boolean }
      ).__LIBRIS_DISABLE_SERVER_EVENTS__ = true;
    });

    await page.goto("/");
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
    await use(page);
  },

  userPage: async ({ browser }, use) => {
    // Create a new context with the regular user's storageState
    const context: BrowserContext = await browser.newContext({
      storageState: ".auth/regular-user.json",
    });
    const page = await context.newPage();

    await page.addInitScript(() => {
      (
        window as Window & { __LIBRIS_DISABLE_SERVER_EVENTS__?: boolean }
      ).__LIBRIS_DISABLE_SERVER_EVENTS__ = true;
    });

    await page.goto("/");
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
    await use(page);

    await context.close();
  },

  livePage: async ({ page }, use) => {
    // Allow WebSocket connections through for real-time event testing.
    // Use domcontentloaded instead of networkidle since WS keeps connection open.
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
    await use(page);
  },
});

export { expect } from "@playwright/test";
