/**
 * Playwright auth setup for the regular (non-admin) user.
 *
 * Authenticates via the Hono API login endpoint using E2E_USER_API_KEY,
 * then persists the session to .auth/regular-user.json so tests that
 * need a non-admin context can use this storageState.
 */

import { mkdirSync } from "node:fs";
import { test as setup } from "@playwright/test";

const API_BASE = "http://localhost:3000";
const AUTH_FILE = ".auth/regular-user.json";

setup("authenticate regular user", async ({ page }) => {
  const apiKey = process.env.E2E_USER_API_KEY;
  if (!apiKey) {
    throw new Error("E2E_USER_API_KEY not set — did global-setup.ts run?");
  }

  // Call the Hono API login endpoint directly to get the httpOnly session cookie
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });

  if (!res.ok) {
    throw new Error(`API login (regular user) failed: ${res.status} ${res.statusText}`);
  }

  const setCookieHeader = res.headers.get("set-cookie");
  if (!setCookieHeader) {
    throw new Error("No Set-Cookie header returned from /api/auth/login (regular user)");
  }

  // Parse Set-Cookie into a Playwright cookie object
  const cookieValue = setCookieHeader.split(";")[0].split("=").slice(1).join("=");

  // Add cookie for both the API (port 3000) and web (port 3100) on localhost
  await page.context().addCookies([
    {
      name: "books-auth",
      value: cookieValue,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  // Navigate to verify the session works, then save state
  await page.goto("/");
  await page.getByRole("link", { name: "Home" }).waitFor({ timeout: 10_000 });

  mkdirSync(".auth", { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
