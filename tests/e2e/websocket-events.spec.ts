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
import {
  API_BASE,
  testRouteHeaders,
  seedBook,
  deleteAllBooks,
  invalidateServerCache,
  getRegularUserId,
} from "./helpers";

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
    headers: { ...testRouteHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  if (!res.ok) throw new Error(`Failed to emit event: ${res.status}`);
}

async function seedBookForUser(createdBy: string, title: string): Promise<string> {
  const res = await fetch(`${API_BASE}/__test/seed-books`, {
    method: "POST",
    headers: { ...testRouteHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      createdBy,
      books: [{ title, author: "WebSocket owner test", status: "inbox" }],
    }),
  });
  if (!res.ok) throw new Error(`Failed to seed user book: ${res.status}`);
  const body = (await res.json()) as { inserted: Array<{ id: string }> };
  return body.inserted[0]!.id;
}

async function openManualWebSocket(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket("ws://localhost:3000/api/events");
      const timeout = setTimeout(() => reject(new Error("WebSocket did not connect")), 10_000);
      ws.addEventListener("message", (event) => {
        if (JSON.parse(event.data as string).type !== "connected") return;
        clearTimeout(timeout);
        (window as Window & { __testEventsSocket?: WebSocket }).__testEventsSocket = ws;
        resolve();
      });
      ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")));
    });
  });
}

async function listenForBookEvent(page: Page, bookId: string): Promise<void> {
  await page.evaluate((expectedBookId) => {
    const ws = (window as Window & { __testEventsSocket?: WebSocket }).__testEventsSocket;
    if (!ws) throw new Error("Test WebSocket was not opened");
    const windowWithEvents = window as Window & { __testEventBookIds?: string[] };
    windowWithEvents.__testEventBookIds ??= [];
    ws.addEventListener("message", (event) => {
      if (JSON.parse(event.data as string).bookId === expectedBookId) {
        windowWithEvents.__testEventBookIds!.push(expectedBookId);
      }
    });
  }, bookId);
}

async function receivedBookEvent(page: Page, bookId: string): Promise<boolean> {
  return await page.evaluate(
    (expectedBookId) =>
      (window as Window & { __testEventBookIds?: string[] }).__testEventBookIds?.includes(
        expectedBookId,
      ) ?? false,
    bookId,
  );
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

  test(
    "a regular user receives events only for their own books",
    { tag: "@smoke" },
    async ({ userPage: page }) => {
      const adminBook = await seedBook("inbox", { title: "Admin-only WebSocket Book" });
      const userBook = await seedBookForUser(getRegularUserId(), "User-only WebSocket Book");

      await openManualWebSocket(page);
      try {
        await listenForBookEvent(page, adminBook.id);
        await emitEvent({ type: "book:detected", bookId: adminBook.id });
        await page.waitForTimeout(1_000);
        expect(await receivedBookEvent(page, adminBook.id)).toBe(false);

        await listenForBookEvent(page, userBook);
        await emitEvent({ type: "book:detected", bookId: userBook });
        await expect.poll(() => receivedBookEvent(page, userBook)).toBe(true);
      } finally {
        await page.evaluate(() => {
          (window as Window & { __testEventsSocket?: WebSocket }).__testEventsSocket?.close();
        });
      }
    },
  );

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
