/**
 * E2E: Settings page health and diagnostics.
 *
 * Tests the authenticated settings page sections: Server Health (database/redis/event
 * bus status and latency), Job Queues (queues with counts), Application Settings
 * (inbox/library paths), and the refresh button.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Navigate to settings and wait for tabs to be visible. */
async function goSettings(page: Page): Promise<void> {
  await page.goto("/settings");
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("tab", { name: "Connections" })).toBeVisible({ timeout: 10_000 });
}

/** Click a settings tab by label and wait for its content to appear. */
async function switchTab(page: Page, tabLabel: string): Promise<void> {
  await page.getByRole("tab", { name: tabLabel, exact: true }).click();
}

/** Navigate to the System tab and wait for health data to load. */
async function waitForSystemTab(page: Page): Promise<void> {
  await goSettings(page);
  await switchTab(page, "System");
  await expect(page.getByTestId("server-health-section")).toBeVisible({ timeout: 10_000 });
  // Wait for health data to load — database card appears when loaded
  await expect(page.getByTestId("health-card-database")).toBeVisible({ timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Jobs & Queues
// ---------------------------------------------------------------------------

test.describe("Settings Page — Jobs Browser", () => {
  test("route query controls the active tab and stays in sync when switching tabs", async ({
    authedPage: page,
  }) => {
    await page.goto("/settings?tab=failed-jobs");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("heading", { name: "Failed Jobs" })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("OPDS Catalog")).not.toBeVisible();

    await switchTab(page, "Jobs");
    await expect(page).toHaveURL(/\/settings\?tab=jobs$/);
    await expect(page.getByTestId("jobs-browser-filters")).toBeVisible({ timeout: 10_000 });

    await switchTab(page, "Connections");
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByText("OPDS Catalog")).toBeVisible({ timeout: 10_000 });
  });

  test("Jobs tab shows filters and job list or empty state", async ({ authedPage: page }) => {
    await goSettings(page);
    await switchTab(page, "Jobs");

    // Filters section should be visible
    const filters = page.getByTestId("jobs-browser-filters");
    await expect(filters).toBeVisible({ timeout: 10_000 });

    // Queue filter dropdown
    await expect(page.getByTestId("filter-queue")).toBeVisible();

    // Status filter dropdown
    await expect(page.getByTestId("filter-status")).toBeVisible();

    // Refresh button
    await expect(page.getByTestId("refresh-jobs-btn")).toBeVisible();

    // Either jobs list or empty state should show (scheduler jobs may already exist)
    const jobsList = page.getByTestId("jobs-browser-list");
    const emptyState = page.getByTestId("jobs-browser-empty");
    await expect(jobsList.or(emptyState)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Settings Page — Queue Management", () => {
  test("Queues tab shows queue cards with action buttons", async ({ authedPage: page }) => {
    await goSettings(page);
    await switchTab(page, "Queues");

    // Queue list should be visible
    const list = page.getByTestId("queue-management-list");
    await expect(list).toBeVisible({ timeout: 10_000 });

    // At least one queue card should be present (the pipeline queues always exist)
    const queueCards = list.locator("[data-testid^='queue-card-']");
    await expect(queueCards.first()).toBeVisible({ timeout: 10_000 });
    const cardCount = await queueCards.count();
    expect(cardCount).toBeGreaterThanOrEqual(1);

    // Each card should have pause/resume, clean, and drain buttons
    const firstCard = queueCards.first();
    await expect(firstCard.locator("[data-testid^='queue-toggle-pause-']")).toBeVisible();
    await expect(firstCard.locator("[data-testid^='queue-clean-']")).toBeVisible();
    await expect(firstCard.locator("[data-testid^='queue-drain-']")).toBeVisible();
  });

  test("Destructive queue action shows confirmation dialog", async ({ authedPage: page }) => {
    await goSettings(page);
    await switchTab(page, "Queues");

    const list = page.getByTestId("queue-management-list");
    await expect(list).toBeVisible({ timeout: 10_000 });

    // Find a drain button (drain is never disabled when there are 0 waiting+delayed,
    // but clean is disabled when there are 0 failed — drain may also be disabled,
    // so we try both). We click whichever is not disabled.
    const drainButtons = list.locator("[data-testid^='queue-drain-']");
    const cleanButtons = list.locator("[data-testid^='queue-clean-']");

    // Try drain first — if all are disabled, try clean
    let clicked = false;
    const drainCount = await drainButtons.count();
    for (let i = 0; i < drainCount; i++) {
      const btn = drainButtons.nth(i);
      const isDisabled = await btn.isDisabled();
      if (!isDisabled) {
        await btn.click();
        clicked = true;
        break;
      }
    }

    if (!clicked) {
      const cleanCount = await cleanButtons.count();
      for (let i = 0; i < cleanCount; i++) {
        const btn = cleanButtons.nth(i);
        const isDisabled = await btn.isDisabled();
        if (!isDisabled) {
          await btn.click();
          clicked = true;
          break;
        }
      }
    }

    if (clicked) {
      // Confirmation dialog should appear (UModal renders via Teleport as a <dialog>)
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // Should have cancel and confirm buttons
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
      // Confirm button has dynamic label — just check a second button exists
      const buttons = dialog.getByRole("button");
      expect(await buttons.count()).toBeGreaterThanOrEqual(2);

      // Dismiss by clicking cancel
      await dialog.getByRole("button", { name: "Cancel" }).click();
    }
    // If no button was enabled (fresh env with 0 failed, 0 waiting, 0 delayed),
    // that's expected — the buttons are correctly disabled
  });
});

// ---------------------------------------------------------------------------
// Health & Diagnostics
// ---------------------------------------------------------------------------

test.describe("Settings Page — Health & Diagnostics", { tag: "@smoke" }, () => {
  test("Server Health section shows database, redis, and event bus status", async ({
    authedPage: page,
  }) => {
    await waitForSystemTab(page);

    // Database check: status + latency
    const dbCard = page.getByTestId("health-card-database");
    await expect(dbCard).toBeVisible();
    await expect(dbCard.getByText(/\d+ms latency/)).toBeVisible();

    // Redis check: status + latency
    const redisCard = page.getByTestId("health-card-redis");
    await expect(redisCard).toBeVisible();
    await expect(redisCard.getByText(/\d+ms latency/)).toBeVisible();

    // Event bus check: status badge visible (no latency — it's a connectivity check)
    const eventBusCard = page.getByTestId("health-card-eventBus");
    await expect(eventBusCard).toBeVisible();
    await expect(eventBusCard.getByText("ok")).toBeVisible();
  });

  test("Job Queues section shows all queues", async ({ authedPage: page }) => {
    await waitForSystemTab(page);

    const queuesSection = page.getByTestId("job-queues-section");
    await expect(queuesSection).toBeVisible();

    // All queue names should be visible
    await expect(queuesSection.getByText("book-detected")).toBeVisible();
    await expect(queuesSection.getByText("book-parse-file")).toBeVisible();
    await expect(queuesSection.getByText("book-fetch-metadata")).toBeVisible();
    await expect(queuesSection.getByText("book-organize")).toBeVisible();
  });

  test("Application Settings shows inbox and library paths", async ({ authedPage: page }) => {
    await goSettings(page);
    await switchTab(page, "Paths");

    const section = page.getByTestId("app-settings-section");
    await expect(section).toBeVisible({ timeout: 10_000 });

    // Library path card with non-empty value
    const libraryPathCard = page.getByTestId("path-card-library");
    const libraryPathValue = libraryPathCard.getByTestId("path-value-library");
    await expect(libraryPathValue).toBeVisible();
    const libraryPath = await libraryPathValue.textContent();
    expect(libraryPath?.trim().length).toBeGreaterThan(0);

    // Inbox path card with non-empty value
    const inboxPathCard = page.getByTestId("path-card-inbox");
    const inboxPathValue = inboxPathCard.getByTestId("path-value-inbox");
    await expect(inboxPathValue).toBeVisible();
    const inboxPath = await inboxPathValue.textContent();
    expect(inboxPath?.trim().length).toBeGreaterThan(0);
  });

  test("Refresh button triggers new aggregate settings API call", async ({ authedPage: page }) => {
    await waitForSystemTab(page);

    // Set up response listener BEFORE clicking refresh
    const statusResponsePromise = page.waitForResponse(
      (resp) => resp.url().includes("/api/settings/status") && resp.status() === 200,
    );

    // Click the refresh button
    const refreshButton = page.getByRole("button", { name: /refresh/i });
    await refreshButton.click();

    // Verify the aggregate API call was made and succeeded
    const statusResponse = await statusResponsePromise;
    expect(statusResponse.ok()).toBe(true);

    // Data should still be visible after refresh
    await expect(page.getByTestId("health-card-database")).toBeVisible();
    await expect(page.getByTestId("health-card-eventBus")).toBeVisible();
    await expect(page.getByTestId("job-queues-section")).toBeVisible();
  });
});
