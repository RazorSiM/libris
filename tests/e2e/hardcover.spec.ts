/**
 * E2E: Hardcover settings — credential CRUD and UI state transitions.
 *
 * Tests the Hardcover section on the Connections tab of the settings page:
 * saving/removing an API token, UI state transitions between unconfigured and
 * configured states, sync button visibility, and persistence across reloads.
 *
 * Since the Hardcover API calls happen server-side (API → Hardcover) and
 * cannot be intercepted by Playwright's page.route(), these tests exercise
 * the credential storage (local DB) and UI behaviour rather than real API
 * integration. With a fake token the status will show "Not connected".
 */

import { test, expect } from "./fixtures";
import { goPath, getSql, invalidateServerCache } from "./helpers";

test.describe("Hardcover Settings", { tag: "@smoke" }, () => {
  test.describe.configure({ mode: "serial" });

  /** Remove all hardcover credentials, sync log entries, and settings from the DB. */
  async function cleanHardcoverCredentials() {
    const sql = getSql();
    try {
      await sql`DELETE FROM service_credentials WHERE service = 'hardcover'`;
      await sql`DELETE FROM hardcover_sync_log`;
      await sql`DELETE FROM app_settings WHERE key LIKE 'hardcover.%'`;
    } finally {
      await sql.end();
    }
    await invalidateServerCache();
  }

  test.beforeAll(async () => {
    await cleanHardcoverCredentials();
  });

  test.afterAll(async () => {
    await cleanHardcoverCredentials();
  });

  test("shows empty state when no token configured", async ({ authedPage: page }) => {
    await goPath(page, "/settings");

    // Token input should be visible in the unconfigured state
    const tokenInput = page.getByTestId("hardcover-token-input");
    await expect(tokenInput).toBeVisible();

    // Save button present
    await expect(page.getByTestId("hardcover-save-btn")).toBeVisible();

    // Remove button is only shown when credentials are configured
    await expect(page.getByTestId("hardcover-remove-btn")).not.toBeVisible();

    // Status indicator always renders — shows "Not connected" without credentials
    const status = page.getByTestId("hardcover-status");
    await expect(status).toBeVisible();
    await expect(status).toContainText("Not connected");

    // Feature toggles should NOT be visible without a configured token
    await expect(page.getByTestId("hardcover-metadata-toggle")).not.toBeVisible();
    await expect(page.getByTestId("hardcover-sync-toggle")).not.toBeVisible();
  });

  test("saves Hardcover token and transitions to configured state", async ({
    authedPage: page,
  }) => {
    await goPath(page, "/settings");

    const tokenInput = page.getByTestId("hardcover-token-input");
    await tokenInput.fill("test-hardcover-token-12345");
    await page.getByTestId("hardcover-save-btn").click();

    // After saving the token the UI transitions to the configured state:
    // - "Token configured" text appears
    // - Remove button becomes visible
    // - Token input hides
    await expect(page.getByText("Token configured")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("hardcover-remove-btn")).toBeVisible();
    await expect(page.getByTestId("hardcover-token-input")).not.toBeVisible();
  });

  test("shows connection status after saving token", async ({ authedPage: page }) => {
    await goPath(page, "/settings");

    // Status indicator should still be visible (token is fake, so "Not connected")
    const status = page.getByTestId("hardcover-status");
    await expect(status).toBeVisible({ timeout: 10_000 });
    await expect(status).toContainText("Not connected");
  });

  test("sync button is visible when credentials are configured", async ({ authedPage: page }) => {
    await goPath(page, "/settings");

    const syncBtn = page.getByTestId("hardcover-sync-btn");
    await expect(syncBtn).toBeVisible({ timeout: 10_000 });
    await expect(syncBtn).toContainText("Sync Now");
  });

  test("sync log toggle shows empty log", async ({ authedPage: page }) => {
    await goPath(page, "/settings");

    // Click "Show Sync Log" button
    const toggleBtn = page.getByRole("button", { name: "Show Sync Log" });
    await expect(toggleBtn).toBeVisible({ timeout: 10_000 });
    await toggleBtn.click();

    // Sync log container should appear with empty-state message
    const syncLog = page.getByTestId("hardcover-sync-log");
    await expect(syncLog).toBeVisible({ timeout: 5_000 });
    await expect(syncLog).toContainText("No sync log entries yet");
  });

  test("feature toggles are visible when token is configured", async ({ authedPage: page }) => {
    await goPath(page, "/settings");

    // Both toggles should be visible
    const metadataToggle = page.getByTestId("hardcover-metadata-toggle");
    const syncToggle = page.getByTestId("hardcover-sync-toggle");
    await expect(metadataToggle).toBeVisible({ timeout: 10_000 });
    await expect(syncToggle).toBeVisible();

    // Verify labels
    await expect(page.getByTestId("hardcover-metadata-label")).toBeVisible();
    await expect(page.getByTestId("hardcover-sync-label")).toBeVisible();
  });

  test("toggling sync off disables Sync Now button", async ({ authedPage: page }) => {
    await goPath(page, "/settings");

    const syncToggle = page.getByTestId("hardcover-sync-toggle");
    const metadataToggle = page.getByTestId("hardcover-metadata-toggle");
    const syncBtn = page.getByTestId("hardcover-sync-btn");

    await expect(syncToggle).toBeVisible({ timeout: 10_000 });

    // Turn off sync toggle
    await syncToggle.click();
    // Turn off metadata toggle too — both off should disable sync button
    await metadataToggle.click();

    await expect(syncBtn).toBeDisabled();

    // Re-enable both for subsequent tests
    await metadataToggle.click();
    await syncToggle.click();
    await expect(syncBtn).toBeEnabled();
  });

  test("feature toggle state persists across page reload", async ({ authedPage: page }) => {
    await goPath(page, "/settings");

    const syncToggle = page.getByTestId("hardcover-sync-toggle");
    await expect(syncToggle).toBeVisible({ timeout: 10_000 });

    // Toggle sync off
    await syncToggle.click();

    // Reload page
    await goPath(page, "/settings");

    // Sync toggle should still be off (unchecked)
    const syncToggleAfter = page.getByTestId("hardcover-sync-toggle");
    await expect(syncToggleAfter).toBeVisible({ timeout: 10_000 });
    await expect(syncToggleAfter).not.toBeChecked();

    // Re-enable for cleanup
    await syncToggleAfter.click();
  });

  test("remove token resets to unconfigured state", async ({ authedPage: page }) => {
    await goPath(page, "/settings");

    const removeBtn = page.getByTestId("hardcover-remove-btn");
    await expect(removeBtn).toBeVisible({ timeout: 10_000 });
    await removeBtn.click();

    // After removal the token input should reappear
    await expect(page.getByTestId("hardcover-token-input")).toBeVisible({ timeout: 10_000 });

    // Remove and sync buttons should be gone
    await expect(page.getByTestId("hardcover-remove-btn")).not.toBeVisible();
    await expect(page.getByTestId("hardcover-sync-btn")).not.toBeVisible();
  });

  test("settings persist across page reload", async ({ authedPage: page }) => {
    // Save a token
    await goPath(page, "/settings");
    const tokenInput = page.getByTestId("hardcover-token-input");
    await tokenInput.fill("test-persist-token");
    await page.getByTestId("hardcover-save-btn").click();
    await expect(page.getByText("Token configured")).toBeVisible({ timeout: 10_000 });

    // Full navigation to the settings page again (simulates reload)
    await goPath(page, "/settings");

    // Should still show the configured state, not the token input
    await expect(page.getByText("Token configured")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("hardcover-remove-btn")).toBeVisible();
    await expect(page.getByTestId("hardcover-token-input")).not.toBeVisible();
  });
});
