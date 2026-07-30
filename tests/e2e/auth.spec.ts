/**
 * E2E: Auth setup and API key lifecycle.
 *
 * Tests the complete auth flow: unauthenticated redirect → settings page →
 * setup form → manual key entry (login) → authenticated view (tabs) →
 * logout → redirect back to setup → session persistence across reloads.
 *
 * NOTE: The global-setup.ts seeds an API key before tests run, so the "Run Setup"
 * button returns 409 (keys already exist). The successful setup path is verified
 * by the global-setup itself; this spec tests the error case and the manual entry flow.
 */

import { test, expect, type Page } from "@playwright/test";
import { getApiKey } from "./helpers";

/** Navigate to /settings, wait for hydration, and log in with the seeded API key. */
async function loginViaUI(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Welcome to Libris — Set Up Your API Key")).toBeVisible();
  await page.getByPlaceholder("Enter your API key").fill(getApiKey());
  await page.getByRole("button", { name: "Login" }).click();
}

test.describe("Auth Setup & API Key Lifecycle", { tag: "@smoke" }, () => {
  // These tests verify unauthenticated flows — clear the project-level storageState
  test.use({ storageState: { cookies: [], origins: [] } });
  test("redirects to /settings when no API key is configured", async ({ page }) => {
    // Fresh browser context — no session cookie
    await page.goto("/");
    await page.waitForURL("**/settings");
  });

  test("displays setup form with initial setup and manual entry options", async ({ page }) => {
    await page.goto("/settings");

    // Welcome heading
    await expect(page.getByText("Welcome to Libris — Set Up Your API Key")).toBeVisible();
    await expect(page.getByText("No API key configured")).toBeVisible();

    // Initial Setup section
    await expect(page.getByRole("heading", { name: "Initial Setup" })).toBeVisible();
    await expect(
      page.getByText("Creates the first API key for this server. Only works once."),
    ).toBeVisible();
    await expect(page.getByPlaceholder("e.g. Web UI")).toBeVisible();
    await expect(page.getByRole("button", { name: "Run Setup" })).toBeVisible();

    // Manual entry section
    await expect(page.getByText("or enter existing key")).toBeVisible();
    await expect(page.getByPlaceholder("Enter your API key")).toBeVisible();

    // Login button visible
    await expect(page.getByRole("button", { name: "Login" })).toBeVisible();
  });

  test("Run Setup shows error when keys already exist", async ({ page }) => {
    // Global setup already created a key → POST /api/auth/setup returns 409
    await page.goto("/settings");
    await expect(page.getByText("Welcome to Libris — Set Up Your API Key")).toBeVisible();

    await page.getByRole("button", { name: "Run Setup" }).click();

    // Should remain on the setup form (not transition to authenticated view)
    await expect(page.getByText("Welcome to Libris — Set Up Your API Key")).toBeVisible();

    // Button should stop loading and remain clickable
    await expect(page.getByRole("button", { name: "Run Setup" })).toBeEnabled({
      timeout: 10_000,
    });
  });

  test("manual key entry logs in and shows authenticated sections", async ({ page }) => {
    await loginViaUI(page);

    // Authenticated view: tabbed layout should appear with Connections as default tab
    await expect(page.getByRole("tab", { name: "Connections" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: "Logout" })).toBeVisible();

    // Switch to System tab for Server Health and Job Queues
    await page.getByRole("tab", { name: "System" }).click();
    await expect(page.getByText("Server Health")).toBeVisible();
    await expect(page.getByText("Status of backend services.")).toBeVisible();
    // Wait for health data to load
    await expect(page.getByText("database").first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("redis").first()).toBeVisible();

    // Job Queues section (also on System tab)
    await expect(page.getByText("Job Queues")).toBeVisible();
    await expect(page.getByText("BullMQ queue statistics.")).toBeVisible();

    // Switch to Paths tab for Application Settings
    await page.getByRole("tab", { name: "Paths" }).click();
    await expect(page.getByText("Application Settings")).toBeVisible();
    await expect(page.getByText("Library Path")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Inbox Path")).toBeVisible();
  });

  test("logout reverts to setup view", async ({ page }) => {
    await loginViaUI(page);
    await expect(page.getByRole("button", { name: "Logout" })).toBeVisible({ timeout: 10_000 });

    // Logout — wait for the API response to complete before asserting
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/auth/logout") && r.status() === 200),
      page.getByRole("button", { name: "Logout" }).click(),
    ]);

    // Should revert to unauthenticated view
    await expect(page.getByText("Welcome to Libris — Set Up Your API Key")).toBeVisible();

    // Health, queues, paths sections should be gone
    await expect(page.getByText("Server Health")).not.toBeVisible();
    await expect(page.getByText("Job Queues")).not.toBeVisible();
    await expect(page.getByText("Application Settings")).not.toBeVisible();
  });

  test("after logout, navigation redirects back to /settings", async ({ page }) => {
    await loginViaUI(page);
    await expect(page.getByRole("button", { name: "Logout" })).toBeVisible({ timeout: 10_000 });
    await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/auth/logout") && r.status() === 200),
      page.getByRole("button", { name: "Logout" }).click(),
    ]);
    await expect(page.getByText("Welcome to Libris — Set Up Your API Key")).toBeVisible();

    // Navigate away — should redirect back to /settings
    await page.goto("/");
    await page.waitForURL("**/settings");
  });

  test("session persists across page reloads", async ({ page }) => {
    await loginViaUI(page);
    // Wait for tabbed layout to appear (confirms auth succeeded)
    await expect(page.getByRole("tab", { name: "Connections" })).toBeVisible({ timeout: 10_000 });

    // Reload the page (don't wait for networkidle — WebSocket keeps connection open)
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    // Wait for concrete auth-dependent element (tabbed layout) before asserting
    await expect(page.getByRole("tab", { name: "Connections" })).toBeVisible({ timeout: 15_000 });
    // Setup form should NOT be shown
    await expect(page.getByText("Welcome to Libris — Set Up Your API Key")).not.toBeVisible();
    // System tab should also be accessible — wait for hydration before clicking
    const systemTab = page.getByRole("tab", { name: "System" });
    await systemTab.click();
    // If the tab panel didn't switch (hydration race), retry the click
    const serverHealth = page.getByText("Server Health");
    if (!(await serverHealth.isVisible().catch(() => false))) {
      await page.waitForTimeout(500);
      await systemTab.click();
    }
    await expect(serverHealth).toBeVisible({ timeout: 10_000 });
  });
});
