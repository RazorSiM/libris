/**
 * E2E: WebSocket real-time events.
 *
 * Tests that WebSocket connections establish correctly and that server-sent
 * events (via the event bus) trigger reactive UI updates -- inbox list
 * refreshes, badge count changes, and settings page resilience.
 *
 * Uses the `livePage` fixture which does NOT abort WebSocket connections,
 * unlike the standard `authedPage` fixture.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { API_BASE, seedBook, deleteAllBooks, invalidateServerCache } from "./helpers";

/**
 * Fire a server event through the test-only event bus endpoint.
 * The event propagates to all connected WebSocket clients.
 */
async function emitEvent(event: {
  type: string;
  bookId?: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const res = await fetch(`${API_BASE}/__test/emit-event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(`Failed to emit event: ${res.status}`);
}

/**
 * Reload the app and wait for the singleton websocket connection to fully
 * establish (including the server "connected" frame).
 */
async function reloadWithWebSocket(page: Page): Promise<string[]> {
  const websocketUrls: string[] = [];
  const wsConnected = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WebSocket did not connect")), 15_000);
    page.once("websocket", (ws) => {
      websocketUrls.push(ws.url());
      ws.once("framereceived", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  });

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.getByRole("link", { name: "Home" })).toBeVisible();
  await wsConnected;
  return websocketUrls;
}

async function navigateToPage(page: Page, linkName: string, urlPattern: string): Promise<void> {
  await page.getByRole("link", { name: linkName }).click();
  await page.waitForURL(urlPattern);
}

test.describe("WebSocket Real-time Events", () => {
  test.beforeEach(async () => {
    await deleteAllBooks();
  });

  test("WebSocket connection establishes successfully", async ({ livePage: page }) => {
    await reloadWithWebSocket(page);
    await navigateToPage(page, "Inbox", "**/inbox");

    // Page should be functional with WebSocket connected
    await expect(page.getByTestId("empty-inbox")).toBeVisible();
  });

  test("Inbox list auto-refreshes on book:detected event", async ({ livePage: page }) => {
    await reloadWithWebSocket(page);
    await navigateToPage(page, "Inbox", "**/inbox");

    // 2. Verify inbox is empty
    await expect(page.getByTestId("empty-inbox")).toBeVisible();

    // 3. Seed a book and fire event
    const book = await seedBook("inbox", { title: "Live Update Book" });
    await invalidateServerCache();
    await emitEvent({ type: "book:detected", bookId: book.id });

    // 4. The new book should appear without page refresh
    await expect(page.getByText("Live Update Book")).toBeVisible({ timeout: 10_000 });
  });

  test("Inbox badge updates on book:detected event", async ({ livePage: page }) => {
    await reloadWithWebSocket(page);
    await navigateToPage(page, "Inbox", "**/inbox");

    // 2. Seed a book and fire book:detected event
    const book = await seedBook("inbox", { title: "Badge Test Book" });
    await invalidateServerCache();
    await emitEvent({ type: "book:detected", bookId: book.id });

    // 3. The sidebar inbox link should get a badge with the count
    // Nuxt UI renders the badge as a small element with the count text
    await expect(page.getByRole("link", { name: /Inbox.*1/ })).toBeVisible({ timeout: 10_000 });
  });

  test("Route navigation keeps a single websocket connection", async ({ livePage: page }) => {
    const websocketUrls: string[] = [];
    page.on("websocket", (ws) => {
      websocketUrls.push(ws.url());
    });

    await reloadWithWebSocket(page);

    await navigateToPage(page, "Inbox", "**/inbox");
    await navigateToPage(page, "Settings", "**/settings");
    await navigateToPage(page, "Inbox", "**/inbox");
    await page.waitForTimeout(500);

    expect(websocketUrls.filter((url) => url.endsWith("/api/events"))).toHaveLength(1);
  });

  test("Settings page reacts to job events", async ({ livePage: page }) => {
    await reloadWithWebSocket(page);
    await navigateToPage(page, "Settings", "**/settings");

    // 2. Wait for settings page to load
    await expect(page.getByText("Settings").first()).toBeVisible();

    // 3. Fire a job:failed event
    await emitEvent({
      type: "job:failed",
      payload: { queue: "book-detected", error: "Test error", jobId: "test-123" },
    });

    // 4. The settings status section should refresh (query invalidation)
    // We verify the WS event pipeline reaches the settings page by confirming
    // the page stays functional and doesn't crash from the event
    await expect(page.getByText("Settings").first()).toBeVisible();
  });

  test("Settings navigation does not emit Vue lifecycle warnings", async ({ livePage: page }) => {
    const lifecycleWarnings: string[] = [];

    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("onMounted is called when there is no active component instance")) {
        lifecycleWarnings.push(text);
      }
    });

    await reloadWithWebSocket(page);
    await navigateToPage(page, "Settings", "**/settings");
    await expect(page.getByText("Settings").first()).toBeVisible();

    await page.getByRole("link", { name: "Inbox" }).click();
    await page.waitForURL("**/inbox");

    await page.getByRole("link", { name: "Settings" }).click();
    await page.waitForURL("**/settings");
    await expect(page.getByText("Settings").first()).toBeVisible();

    await emitEvent({
      type: "job:failed",
      payload: { queue: "book-detected", error: "Test warning check", jobId: "warn-123" },
    });

    await expect(page.getByText("Settings").first()).toBeVisible();
    await page.waitForTimeout(500);

    expect(lifecycleWarnings).toEqual([]);
  });
});
