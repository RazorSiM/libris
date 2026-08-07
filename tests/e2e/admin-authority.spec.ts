/**
 * E2E: what an app password may NOT do, when its owner is an admin.
 *
 * A separate spec from auth.spec.ts on purpose. The app-password scope block
 * there covers the routes whose admin requirement is declared in the policy
 * table (/api/jobs) and the credential-management routes. What this file covers
 * is the other kind: routes that look ordinary to the routing layer and only
 * reveal their admin authority inside the handler.
 *
 * The threat is concrete. The OPDS credential in a household install belongs to
 * the admin, and it lives in plaintext in a KOReader config on a device that
 * leaves the house. Whoever reads that file used to be able to run
 *
 *   curl -u any:<app-password> https://libris.example/api/settings/status
 *
 * and get back the server's filesystem paths, live database and Redis health,
 * queue depths and the arguments of every failed job — then flip settings with
 * a PATCH. (libris-59m.13)
 *
 * Every test pairs the refusal with the same person's SESSION succeeding. A
 * one-sided version would still pass if the fix had overshot into "nobody may
 * use the settings page".
 */

import { test, expect, request as playwrightRequest } from "@playwright/test";
import { API_BASE, getApiKey, getUserApiKey, sessionHeaders, userSessionHeaders } from "./helpers";

/**
 * request.newContext() inherits the project's storageState, which would arrive
 * carrying the suite's admin cookie and make every "should be 403" assertion
 * pass for the wrong reason.
 */
async function anonymousApi() {
  return await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] } });
}

test.describe("app passwords cannot reach in-handler admin authority", () => {
  test("GET /api/settings/status is refused, while the same admin's session is served", async () => {
    const api = await anonymousApi();

    const withKey = await api.get(`${API_BASE}/api/settings/status`, {
      headers: { Authorization: `Bearer ${getApiKey()}` },
    });
    expect(withKey.status()).toBe(403);

    const withSession = await api.get(`${API_BASE}/api/settings/status`, {
      headers: sessionHeaders(),
    });
    expect(withSession.ok()).toBe(true);
    // The payload the refusal is protecting: diagnostics only admins see.
    const diagnostics = (await withSession.json()) as { settings: { libraryPath?: string } | null };
    expect(diagnostics.settings?.libraryPath).toBeTruthy();

    await api.dispose();
  });

  test("PATCH /api/settings is refused, and changes nothing", async () => {
    const api = await anonymousApi();

    const before = await api.get(`${API_BASE}/api/settings`, { headers: sessionHeaders() });
    const { hardcoverSyncEnabled } = (await before.json()) as { hardcoverSyncEnabled: boolean };

    const attempt = await api.patch(`${API_BASE}/api/settings`, {
      headers: { Authorization: `Bearer ${getApiKey()}` },
      data: { hardcoverSyncEnabled: !hardcoverSyncEnabled },
    });
    expect(attempt.status()).toBe(403);

    const after = await api.get(`${API_BASE}/api/settings`, { headers: sessionHeaders() });
    expect((await after.json()).hardcoverSyncEnabled).toBe(hardcoverSyncEnabled);

    await api.dispose();
  });

  test("GET /api/settings is refused too — it leaks the filesystem paths to admins", async () => {
    const api = await anonymousApi();

    expect(
      (
        await api.get(`${API_BASE}/api/settings`, {
          headers: { Authorization: `Bearer ${getApiKey()}` },
        })
      ).status(),
    ).toBe(403);
    // A non-admin's key is refused on the same prefix: the rule is about the
    // KIND of credential, not about who holds it.
    expect(
      (
        await api.get(`${API_BASE}/api/settings`, {
          headers: { Authorization: `Bearer ${getUserApiKey()}` },
        })
      ).status(),
    ).toBe(403);

    // And a plain member's session still reads the page, minus the paths.
    const member = await api.get(`${API_BASE}/api/settings`, { headers: userSessionHeaders() });
    expect(member.ok()).toBe(true);
    expect(await member.json()).not.toHaveProperty("libraryPath");

    await api.dispose();
  });

  test("none of that touched the surface app passwords exist for", async () => {
    // The regression that would matter most: over-scoping the credential so the
    // e-reader it was minted for stops syncing.
    const api = await anonymousApi();
    const headers = { Authorization: `Bearer ${getApiKey()}` };

    expect((await api.get(`${API_BASE}/api/library`, { headers })).ok()).toBe(true);
    expect((await api.get(`${API_BASE}/api/inbox`, { headers })).ok()).toBe(true);

    await api.dispose();
  });
});
