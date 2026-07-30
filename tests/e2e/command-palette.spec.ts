/**
 * E2E: Command palette (UDashboardSearch).
 *
 * Regression coverage for libris-lroe — the palette previously rendered
 * untranslated i18n keys (`dashboardSearch.title`, `dashboardSearch.description`)
 * because Nuxt UI's English locale does not define them. The app now passes
 * explicit `title` and `description` props to UDashboardSearch.
 *
 * These tests also exercise the representative rendering path (navigation
 * links and book search results) so we catch future regressions in how the
 * palette composes its groups.
 */

import { test, expect } from "./fixtures";
import { cleanInboxDir, deleteAllBooks, seedOrganizedBook, waitForAllQueuesIdle } from "./helpers";

test.describe("Command Palette", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async () => {
    await cleanInboxDir();
    await waitForAllQueuesIdle();
    await deleteAllBooks();
    await seedOrganizedBook({ title: "The Alice Chronicles", author: "Lewis Carroll" });
  });

  test.afterAll(async () => {
    await deleteAllBooks();
  });

  test("opens with translated header — no raw i18n keys rendered", async ({ authedPage: page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();

    await page.keyboard.press("ControlOrMeta+KeyK");

    // The dialog's accessible name and description are wired to its DialogTitle
    // and DialogDescription. If `dashboardSearch.title` / `dashboardSearch.description`
    // leak through (pre-fix behavior), they'd surface here.
    const dialog = page.getByRole("dialog", { name: "Search" });
    await expect(dialog).toBeVisible();

    // Page-wide sanity: the raw i18n keys must not appear anywhere.
    await expect(page.getByText("dashboardSearch.title")).toHaveCount(0);
    await expect(page.getByText("dashboardSearch.description")).toHaveCount(0);
  });

  test("renders navigation links with human labels", async ({ authedPage: page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();

    await page.keyboard.press("ControlOrMeta+KeyK");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The "Go to" group should list navigation entries by their human labels.
    await expect(dialog.getByRole("option", { name: /^Home/ })).toBeVisible();
    await expect(dialog.getByRole("option", { name: /^Library/ })).toBeVisible();
    await expect(dialog.getByRole("option", { name: /^Settings/ })).toBeVisible();
  });

  test("book search shows matching book titles and authors", async ({ authedPage: page }) => {
    await page.goto("/");
    await expect(page.getByRole("link", { name: "Home" })).toBeVisible();

    await page.keyboard.press("ControlOrMeta+KeyK");

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const input = dialog.getByPlaceholder(/Type a command or search/);
    await input.fill("alice");

    // Matching book should appear as an option — title as label, author as suffix.
    await expect(dialog.getByRole("option", { name: /Alice Chronicles/ })).toBeVisible({
      timeout: 5_000,
    });
    await expect(dialog.getByText("Lewis Carroll")).toBeVisible();
  });
});
