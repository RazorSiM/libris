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

import type { Browser, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  API_BASE,
  testRouteHeaders,
  seedBook,
  createDisposableAccount,
  deleteAllBooks,
  invalidateServerCache,
  getRegularUserId,
} from "./helpers";
import { signInThroughUi, signOutThroughUi } from "./helpers/sign-in.js";

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

/**
 * A signed-out browser with the realtime bus left switched on.
 *
 * The standard fixtures set __LIBRIS_DISABLE_SERVER_EVENTS__ so networkidle
 * waits can settle; a spec about the socket obviously cannot.
 */
async function freshLiveContext(browser: Browser) {
  return await browser.newContext({
    baseURL: `http://localhost:${process.env.CI ? 3000 : 3100}`,
    storageState: { cookies: [], origins: [] },
  });
}

/**
 * Watch the app's OWN socket rather than opening one.
 *
 * openManualWebSocket() creates a second connection with its own upgrade, which
 * would pass whatever the app's socket was doing — and the app's socket is the
 * thing under test.
 */
function recordSocketFrames(page: Page) {
  const record = { sockets: 0, payloads: [] as string[] };
  page.on("websocket", (ws) => {
    if (!ws.url().endsWith("/api/events")) return;
    record.sockets += 1;
    ws.on("framereceived", (frame) => record.payloads.push(String(frame.payload)));
  });
  return record;
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

  test(
    "the socket follows the signed-in user across a sign-out and sign-in",
    { tag: "@smoke" },
    async ({ browser }) => {
      // The server binds the subscription's user id and admin flag AT UPGRADE
      // TIME and never re-checks them. Sign-out and sign-in are both SPA
      // navigations, so nothing used to reset the socket: an admin signing out
      // of a shared browser left the next person holding HER admin-scoped
      // subscription. They saw every book event on the install — other users'
      // ids, types and payloads — and none of their own, so their inbox badge
      // and job status silently stopped updating.
      const alice = await createDisposableAccount("ws-alice", "admin");
      const bob = await createDisposableAccount("ws-bob");
      const aliceBook = await seedBookForUser(alice.id, "Alice-owned WebSocket Book");
      const bobBook = await seedBookForUser(bob.id, "Bob-owned WebSocket Book");

      const context = await freshLiveContext(browser);
      const page = await context.newPage();
      const frames = recordSocketFrames(page);

      await page.goto("/login");
      // Nothing to subscribe to while signed out, and dialling here is a
      // reconnect loop against a 401.
      await page.waitForTimeout(1_000);
      expect(frames.sockets).toBe(0);

      await signInThroughUi(page, alice.email, alice.password);
      await expect.poll(() => frames.sockets, { timeout: 15_000 }).toBe(1);

      await signOutThroughUi(page);
      await signInThroughUi(page, bob.email, bob.password);
      // A NEW socket, carrying Bob's cookie.
      await expect.poll(() => frames.sockets, { timeout: 15_000 }).toBeGreaterThan(1);
      await expect.poll(() => frames.payloads.some((f) => f.includes('"connected"'))).toBe(true);

      frames.payloads.length = 0;

      await emitEvent({ type: "book:detected", bookId: bobBook });
      await expect
        .poll(() => frames.payloads.some((f) => f.includes(bobBook)), { timeout: 15_000 })
        .toBe(true);

      await emitEvent({ type: "book:detected", bookId: aliceBook });
      await page.waitForTimeout(2_000);
      expect(frames.payloads.some((f) => f.includes(aliceBook))).toBe(false);

      await context.close();
    },
  );

  test("Settings page refetches its status on a job:failed event", async ({ livePage: page }) => {
    // This used to assert `getByText("Settings")` is visible — the exact
    // assertion it had already made BEFORE emitting the event, so it could not
    // detect whether the event did anything at all.
    //
    // What the event is actually wired to (pages/settings.vue): the
    // `job:failed` handler invalidates the `["settings", "status"]` query, and
    // Pinia Colada refetches it because the page is mounted and using it. So
    // the observable consequence is a fresh GET /api/settings/status — which is
    // what the failed-jobs list and the queue counters are rendered from. Unwire
    // the handler and this times out.
    await reloadWithWebSocket(page);
    await navigateToPage(page, "Settings", "**/settings");
    await expect(page.getByText("Settings").first()).toBeVisible();

    // Let the page's own initial fetch settle first, so the response awaited
    // below can only be the one the event caused.
    await page.waitForLoadState("networkidle");

    const refetched = page.waitForResponse(
      (res) =>
        res.url().includes("/api/settings/status") &&
        res.request().method() === "GET" &&
        res.status() === 200,
      { timeout: 15_000 },
    );

    await emitEvent({
      type: "job:failed",
      payload: { queue: "book-detected", error: "Test error", jobId: "test-123" },
    });

    expect((await refetched).ok()).toBe(true);
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
