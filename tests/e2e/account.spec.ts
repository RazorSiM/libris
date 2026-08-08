/**
 * E2E: the account tab — your own name, password and signed-in devices.
 *
 * Every test here works on a THROWAWAY account, never the shared admin or
 * regular user. A password change rewrites the credential the rest of the suite
 * signs in with, and revoking sessions deletes the storageState the whole run
 * shares. Two specs have poisoned this suite that way before.
 */

import {
  test,
  expect,
  request as playwrightRequest,
  type Browser,
  type Page,
} from "@playwright/test";
import { API_BASE, createDisposableAccount } from "./helpers";
import { signInThroughUi } from "./helpers/sign-in.js";

const BASE_URL = `http://localhost:${process.env.CI ? 3000 : 3100}`;

async function anonymousApi() {
  return await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] } });
}

/** A signed-out browser, so a sign-in here cannot borrow the suite's session. */
async function freshContext(browser: Browser) {
  return await browser.newContext({
    baseURL: BASE_URL,
    storageState: { cookies: [], origins: [] },
  });
}

/** Whether these credentials are accepted, asked outside the browser. */
async function canSignIn(email: string, password: string): Promise<boolean> {
  const api = await anonymousApi();
  const res = await api.post(`${API_BASE}/api/auth/sign-in/email`, { data: { email, password } });
  await api.dispose();
  return res.ok();
}

/** Open the account tab on a page that is already signed in. */
async function openAccountTab(page: Page) {
  await page.goto("/settings?tab=account");
  await expect(page.getByTestId("account-panel")).toBeVisible();
}

async function fillPasswordChange(
  page: Page,
  {
    current,
    next,
    revokeOthers = false,
  }: { current: string; next: string; revokeOthers?: boolean },
) {
  await page.getByTestId("current-password-input").fill(current);
  await page.getByTestId("new-password-input").fill(next);
  await page.getByTestId("confirm-password-input").fill(next);
  if (revokeOthers) await page.getByTestId("revoke-others-checkbox").click();
  await page.getByTestId("change-password-btn").click();
}

// ── Profile ──────────────────────────────────────────────────────────

test.describe("profile", () => {
  test.slow();

  test("renames you, and the chrome catches up without a reload", async ({ browser }) => {
    // The rename response carries only `{ status: true }`, so the new name has
    // to come from re-reading the session. If that is skipped, the save looks
    // like it worked and the sidebar keeps the old name until a full page load.
    const account = await createDisposableAccount("rename");
    const context = await freshContext(browser);
    const page = await context.newPage();
    await signInThroughUi(page, account.email, account.password);
    await openAccountTab(page);

    await expect(page.getByTestId("sidebar-user-label")).toContainText(account.name);

    await page.getByTestId("profile-name-input").fill("Grace Hopper");
    await page.getByTestId("save-profile-btn").click();

    await expect(page.getByTestId("sidebar-user-label")).toContainText("Grace Hopper");
    await expect(page.getByTestId("user-label-badge")).toContainText("Grace Hopper");

    await context.close();
  });

  test("shows your email but will not let you edit it", async ({ browser }) => {
    // Better Auth refuses an email change outright, so an editable field here
    // would be a promise the server does not keep.
    const account = await createDisposableAccount("email-ro");
    const context = await freshContext(browser);
    const page = await context.newPage();
    await signInThroughUi(page, account.email, account.password);
    await openAccountTab(page);

    const email = page.getByTestId("profile-email-input");
    await expect(email).toHaveValue(account.email);
    await expect(email).toHaveAttribute("readonly", "");

    await context.close();
  });

  test("the sidebar name is the way in", async ({ page }) => {
    // "Change my password" is looked for under your own name, not under a tab
    // called Connections. This is the only navigation to the account tab.
    await page.goto("/");
    await page.getByTestId("sidebar-user-label").click();

    await expect(page).toHaveURL(/\/settings\?tab=account/);
    await expect(page.getByTestId("account-panel")).toBeVisible();
  });
});

// ── Changing the password ────────────────────────────────────────────

test.describe("password change", () => {
  test.slow();

  test(
    "the old password stops working and the new one signs in",
    { tag: "@smoke" },
    async ({ browser }) => {
      const account = await createDisposableAccount("pw-swap");
      const NEXT = "a-brand-new-password-99";
      const context = await freshContext(browser);
      const page = await context.newPage();
      await signInThroughUi(page, account.email, account.password);
      await openAccountTab(page);

      await fillPasswordChange(page, { current: account.password, next: NEXT });

      // The form empties on success, which is the UI's only durable signal —
      // the toast has usually expired by the time an assertion reaches it.
      await expect(page.getByTestId("current-password-input")).toHaveValue("");
      await expect(page.getByTestId("new-password-input")).toHaveValue("");

      expect(await canSignIn(account.email, account.password)).toBe(false);
      expect(await canSignIn(account.email, NEXT)).toBe(true);

      await context.close();
    },
  );

  test("a wrong current password is refused, and nothing changes", async ({ browser }) => {
    // The dangerous failure is a form that reports an error but has already
    // written the new password, so the second assertion matters more than the
    // first.
    const account = await createDisposableAccount("pw-wrong");
    const context = await freshContext(browser);
    const page = await context.newPage();
    await signInThroughUi(page, account.email, account.password);
    await openAccountTab(page);

    await fillPasswordChange(page, {
      current: "not-the-current-password",
      next: "would-be-the-new-one-1",
    });

    // Only the current-password field is cleared: the new password was typed
    // twice and is not the thing that was wrong.
    await expect(page.getByTestId("current-password-input")).toHaveValue("");
    await expect(page.getByTestId("new-password-input")).toHaveValue("would-be-the-new-one-1");

    expect(await canSignIn(account.email, account.password)).toBe(true);
    expect(await canSignIn(account.email, "would-be-the-new-one-1")).toBe(false);

    await context.close();
  });

  test("a mismatched confirmation never reaches the server", async ({ browser }) => {
    const account = await createDisposableAccount("pw-mismatch");
    const context = await freshContext(browser);
    const page = await context.newPage();
    await signInThroughUi(page, account.email, account.password);
    await openAccountTab(page);

    let attempted = false;
    page.on("request", (req) => {
      if (req.url().includes("/api/auth/change-password")) attempted = true;
    });

    await page.getByTestId("current-password-input").fill(account.password);
    await page.getByTestId("new-password-input").fill("first-typing-of-it");
    await page.getByTestId("confirm-password-input").fill("second-typing-of-it");
    await page.getByTestId("change-password-btn").click();

    await expect(page.getByText(/must match/i)).toBeVisible();
    expect(attempted).toBe(false);
    expect(await canSignIn(account.email, account.password)).toBe(true);

    await context.close();
  });

  test("does not unpair the e-readers", async ({ browser }) => {
    // The checkbox promises app passwords keep working. They are separate
    // credentials with their own revocation, and silently unpairing every
    // reader in the house would be a worse surprise than not doing it.
    const account = await createDisposableAccount("pw-keys");
    const context = await freshContext(browser);
    const page = await context.newPage();
    await signInThroughUi(page, account.email, account.password);

    await page.goto("/settings?tab=connections");
    await page.getByTestId("field-new-key-label").fill("Paired Kobo");
    await page.getByTestId("create-key-btn").click();
    const key = (await page.getByTestId("new-key-value").textContent())?.trim() ?? "";
    expect(key.length).toBeGreaterThan(10);

    await openAccountTab(page);
    await fillPasswordChange(page, {
      current: account.password,
      next: "changed-under-the-reader-7",
      revokeOthers: true,
    });
    await expect(page.getByTestId("current-password-input")).toHaveValue("");

    const api = await anonymousApi();
    expect((await api.get(`${API_BASE}/api/library`, { headers: { "x-api-key": key } })).ok()).toBe(
      true,
    );
    await api.dispose();

    await context.close();
  });
});

// ── Sign out everywhere else ─────────────────────────────────────────

test.describe("other sessions", () => {
  test.slow();

  test("ticked: ends the other browser and keeps this one", async ({ browser }) => {
    const account = await createDisposableAccount("revoke-on");

    const here = await freshContext(browser);
    const herePage = await here.newPage();
    await signInThroughUi(herePage, account.email, account.password);

    const elsewhere = await freshContext(browser);
    const elsewherePage = await elsewhere.newPage();
    await signInThroughUi(elsewherePage, account.email, account.password);

    await openAccountTab(herePage);
    await fillPasswordChange(herePage, {
      current: account.password,
      next: "kick-the-others-out-5",
      revokeOthers: true,
    });
    await expect(herePage.getByTestId("current-password-input")).toHaveValue("");

    // Better Auth deletes every session and re-issues the current one, so this
    // browser must survive on a fresh cookie rather than sign itself out.
    await herePage.reload();
    await expect(herePage.getByTestId("account-panel")).toBeVisible();

    await elsewherePage.reload();
    await expect(elsewherePage).toHaveURL(/\/login/);

    await here.close();
    await elsewhere.close();
  });

  test("unticked: the other browser stays signed in", async ({ browser }) => {
    // Without this, "ends every other signed-in browser" could be describing
    // something that happens either way, and the checkbox would be decoration.
    const account = await createDisposableAccount("revoke-off");

    const here = await freshContext(browser);
    const herePage = await here.newPage();
    await signInThroughUi(herePage, account.email, account.password);

    const elsewhere = await freshContext(browser);
    const elsewherePage = await elsewhere.newPage();
    await signInThroughUi(elsewherePage, account.email, account.password);

    await openAccountTab(herePage);
    await fillPasswordChange(herePage, {
      current: account.password,
      next: "leave-the-others-alone-3",
    });
    await expect(herePage.getByTestId("current-password-input")).toHaveValue("");

    await elsewherePage.reload();
    await expect(elsewherePage.getByRole("link", { name: "Home" })).toBeVisible();
    expect(new URL(elsewherePage.url()).pathname).not.toBe("/login");

    await here.close();
    await elsewhere.close();
  });
});

// ── The device list ──────────────────────────────────────────────────

test.describe("signed-in devices", () => {
  test.slow();

  /** The rows in the device list, top to bottom. */
  function deviceRows(page: Page) {
    return page.locator('[data-testid^="session-item-"]');
  }

  test("lists this browser, marked, and every other one", async ({ browser }) => {
    const account = await createDisposableAccount("devices");

    const here = await freshContext(browser);
    const herePage = await here.newPage();
    await signInThroughUi(herePage, account.email, account.password);

    const elsewhere = await freshContext(browser);
    await signInThroughUi(await elsewhere.newPage(), account.email, account.password);

    await openAccountTab(herePage);
    await expect(deviceRows(herePage)).toHaveCount(2);

    // Exactly one row is the caller, and it sorts first so it is never the one
    // you revoke by reflex.
    await expect(herePage.getByTestId("current-session-badge")).toHaveCount(1);
    await expect(deviceRows(herePage).first()).toContainText("This browser");

    await here.close();
    await elsewhere.close();
  });

  test("never puts a session token in the page", { tag: "@smoke" }, async ({ browser }) => {
    // revokeSession is keyed by token, and a token IS the cookie value that
    // authenticates that device. Rendering one — as text, an attribute or a
    // testid — would undo the httpOnly cookie for every session at once.
    const account = await createDisposableAccount("no-token");
    const context = await freshContext(browser);
    const page = await context.newPage();
    await signInThroughUi(page, account.email, account.password);
    await openAccountTab(page);
    await expect(deviceRows(page)).toHaveCount(1);

    const leaked = await page.evaluate(async () => {
      const res = await fetch("/api/auth/list-sessions");
      const sessions = (await res.json()) as { token: string }[];
      const html = document.documentElement.outerHTML;
      return sessions.filter((s) => html.includes(s.token)).length;
    });
    expect(leaked).toBe(0);

    await context.close();
  });

  test(
    "signing out one device kills that session and leaves this one alone",
    { tag: "@smoke" },
    async ({ browser }) => {
      const account = await createDisposableAccount("revoke-one");

      const here = await freshContext(browser);
      const herePage = await here.newPage();
      await signInThroughUi(herePage, account.email, account.password);

      const elsewhere = await freshContext(browser);
      const elsewherePage = await elsewhere.newPage();
      await signInThroughUi(elsewherePage, account.email, account.password);

      await openAccountTab(herePage);
      await expect(deviceRows(herePage)).toHaveCount(2);

      // The row that is NOT this browser.
      const other = deviceRows(herePage).filter({ hasNotText: "This browser" });
      await other.getByRole("button", { name: "Sign out" }).click();
      await herePage.getByTestId("confirm-revoke-session-btn").click();

      await expect(deviceRows(herePage)).toHaveCount(1);

      // Gone from the list is not the claim; gone from the server is. With
      // secondaryStorage in play these can disagree, which is the whole reason
      // this goes through the Better Auth API rather than a DELETE.
      await elsewherePage.reload();
      await expect(elsewherePage).toHaveURL(/\/login/);
      await expect(herePage.getByTestId("account-panel")).toBeVisible();

      await here.close();
      await elsewhere.close();
    },
  );

  test("a revoke asks first, and cancelling changes nothing", async ({ browser }) => {
    const account = await createDisposableAccount("revoke-cancel");

    const here = await freshContext(browser);
    const herePage = await here.newPage();
    await signInThroughUi(herePage, account.email, account.password);

    const elsewhere = await freshContext(browser);
    const elsewherePage = await elsewhere.newPage();
    await signInThroughUi(elsewherePage, account.email, account.password);

    await openAccountTab(herePage);
    const other = deviceRows(herePage).filter({ hasNotText: "This browser" });
    await other.getByRole("button", { name: "Sign out" }).click();
    await herePage.getByTestId("cancel-revoke-session-btn").click();

    await expect(deviceRows(herePage)).toHaveCount(2);
    await elsewherePage.reload();
    await expect(elsewherePage.getByRole("link", { name: "Home" })).toBeVisible();

    await here.close();
    await elsewhere.close();
  });

  test("sign out everywhere else clears the rest and keeps this one", async ({ browser }) => {
    const account = await createDisposableAccount("revoke-rest");

    const here = await freshContext(browser);
    const herePage = await here.newPage();
    await signInThroughUi(herePage, account.email, account.password);

    const elsewhere = await freshContext(browser);
    const elsewherePage = await elsewhere.newPage();
    await signInThroughUi(elsewherePage, account.email, account.password);

    await openAccountTab(herePage);
    await expect(deviceRows(herePage)).toHaveCount(2);

    await herePage.getByTestId("sign-out-others-btn").click();
    await herePage.getByTestId("confirm-sign-out-others-btn").click();

    await expect(deviceRows(herePage)).toHaveCount(1);
    // Nothing left to sign out, so the button goes away rather than sitting
    // there doing nothing.
    await expect(herePage.getByTestId("sign-out-others-btn")).toHaveCount(0);

    await elsewherePage.reload();
    await expect(elsewherePage).toHaveURL(/\/login/);
    await expect(herePage.getByTestId("account-panel")).toBeVisible();

    await here.close();
    await elsewhere.close();
  });

  test("signing out this browser really signs it out, not just visually", async ({ browser }) => {
    // The dangerous version leaves the cookie alive while the SPA renders a
    // signed-out shell — the user believes they are out and walks away.
    const account = await createDisposableAccount("revoke-self");
    const context = await freshContext(browser);
    const page = await context.newPage();
    await signInThroughUi(page, account.email, account.password);
    await openAccountTab(page);

    await deviceRows(page)
      .filter({ hasText: "This browser" })
      .getByRole("button", { name: "Sign out" })
      .click();
    await page.getByTestId("confirm-revoke-session-btn").click();

    await expect(page).toHaveURL(/\/login/);
    const status = await page.evaluate(async () => (await fetch("/api/library")).status);
    expect(status).toBe(401);

    await context.close();
  });

  test("a password change updates the list without a reload", async ({ browser }) => {
    // The card renders directly below the password form, so it is on screen at
    // the moment it becomes wrong. Before this was fixed, the change succeeded,
    // the toast said every other browser was signed out, and the list below
    // still offered a live "Sign out" button for the phone that was already
    // out — which then failed against a token that no longer existed, leaving
    // the user unable to tell whether the revocation had worked.
    const account = await createDisposableAccount("pw-devices");

    const here = await freshContext(browser);
    const herePage = await here.newPage();
    await signInThroughUi(herePage, account.email, account.password);

    const elsewhere = await freshContext(browser);
    await signInThroughUi(await elsewhere.newPage(), account.email, account.password);

    await openAccountTab(herePage);
    await expect(deviceRows(herePage)).toHaveCount(2);

    await fillPasswordChange(herePage, {
      current: account.password,
      next: "devices-must-catch-up-4",
      revokeOthers: true,
    });
    await expect(herePage.getByTestId("current-password-input")).toHaveValue("");

    // No reload anywhere in this test: that is the assertion.
    await expect(deviceRows(herePage)).toHaveCount(1);
    // And the badge survives the token rotation. It is derived by comparing the
    // listed tokens against the current session's, so a stale list loses it
    // even when the row count happens to be right.
    await expect(herePage.getByTestId("current-session-badge")).toHaveCount(1);
    await expect(herePage.getByTestId("sign-out-others-btn")).toHaveCount(0);

    await here.close();
    await elsewhere.close();
  });

  test("works on a session older than the default freshness window", async ({ browser }) => {
    // list-sessions sits behind freshSessionMiddleware, whose default window is
    // 24 hours against a seven-day session. This asserts the page loads at all;
    // the aged-session case is pinned properly in auth.integration.test.ts,
    // where the stored createdAt can actually be moved.
    const account = await createDisposableAccount("fresh-window");
    const context = await freshContext(browser);
    const page = await context.newPage();
    await signInThroughUi(page, account.email, account.password);
    await openAccountTab(page);

    await expect(page.getByTestId("account-sessions-card")).toBeVisible();
    await expect(page.getByTestId("sessions-error")).toHaveCount(0);
    await expect(deviceRows(page)).toHaveCount(1);

    await context.close();
  });
});

// ── Losing the session while the tab is open ─────────────────────────

test.describe("server-side invalidation", () => {
  test.slow();

  test(
    "a session revoked elsewhere lands the next navigation on /login",
    { tag: "@smoke" },
    async ({ browser }) => {
      // The SPA used to have no 401 handler at all: check() short-circuits on
      // `checked` for the rest of the page's life, so the router guard let every
      // navigation through while every query 401'd into "Something went wrong".
      // The tab looked signed in over a dead cookie until someone reloaded it.
      const account = await createDisposableAccount("revoked-elsewhere");

      const here = await freshContext(browser);
      const herePage = await here.newPage();
      await signInThroughUi(herePage, account.email, account.password);
      await herePage.goto("/library");
      await expect(herePage.getByRole("link", { name: "Home" })).toBeVisible();

      // The other browser signs everything else out — this one included.
      const elsewhere = await freshContext(browser);
      const elsewherePage = await elsewhere.newPage();
      await signInThroughUi(elsewherePage, account.email, account.password);
      await openAccountTab(elsewherePage);
      await elsewherePage.getByTestId("sign-out-others-btn").click();
      await elsewherePage.getByTestId("confirm-sign-out-others-btn").click();
      await expect(elsewherePage.getByTestId("sign-out-others-btn")).toHaveCount(0);

      // An in-app navigation, not a reload: the SPA has to notice by itself.
      // Best-effort, because a background refetch may get there first — either
      // way the app discovered it without being reloaded, which is the claim.
      await herePage
        .getByRole("link", { name: "Inbox" })
        .click({ timeout: 5_000 })
        .catch(() => {});

      await expect(herePage).toHaveURL(/\/login/, { timeout: 15_000 });

      await here.close();
      await elsewhere.close();
    },
  );

  test("an admin cannot set a password on their own row", async ({ browser }) => {
    // The server's after-hook deletes every session belonging to the target, so
    // pointing "Set password" at your own row destroys the cookie in the tab you
    // are using. "Ban" was gated on isSelf from the start; this was not, and the
    // toast reported success while the app 401'd its way into nothing.
    const admin = await createDisposableAccount("self-setpw", "admin");
    const context = await freshContext(browser);
    const page = await context.newPage();
    await signInThroughUi(page, admin.email, admin.password);

    await page.goto("/settings?tab=users");
    await expect(page.getByTestId("users-panel")).toBeVisible();

    const own = page.getByTestId(`set-password-btn-${admin.id}`);
    await expect(own).toBeVisible();
    await expect(own).toBeDisabled();
    // Still on the Users tab with a live session, which is the point.
    await expect(page).toHaveURL(/tab=users/);

    await context.close();
  });
});

// ── Who gets to use it ───────────────────────────────────────────────

test.describe("access", () => {
  test.slow();

  test(
    "a non-admin manages their own account, and is told how to recover it",
    { tag: "@smoke" },
    async ({ browser }) => {
      // Nothing here is an admin concern. A regular user who cannot change their
      // own password has to ask someone else to do it for them every time.
      const account = await createDisposableAccount("plain-user");
      const context = await freshContext(browser);
      const page = await context.newPage();
      await signInThroughUi(page, account.email, account.password);
      await openAccountTab(page);

      await expect(page.getByRole("tab", { name: "Users" })).toHaveCount(0);
      await expect(page.getByTestId("account-recovery-note")).toContainText(/admin/i);
      // Devices are yours too — a user who cannot see where they are signed in
      // cannot notice that somebody else is.
      await expect(page.getByTestId("account-sessions-card")).toBeVisible();

      await fillPasswordChange(page, { current: account.password, next: "chosen-by-me-alone-2" });
      await expect(page.getByTestId("current-password-input")).toHaveValue("");
      expect(await canSignIn(account.email, "chosen-by-me-alone-2")).toBe(true);

      await context.close();
    },
  );
});
