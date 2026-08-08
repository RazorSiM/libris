/**
 * Whose Hardcover quota the scheduled install-wide phase spends.
 *
 * ISBN matching and the page-count backfill run once per scheduled sync over
 * the whole catalog. The worker used to fund them from `validUsers[0]` — the
 * first row the credential query returned — so an ordinary member's third-party
 * API quota paid for install-wide work, and which member it was moved between
 * runs. The phase now runs on an admin's token, deterministically, or not at
 * all.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { eq } from "drizzle-orm";
import { bootstrapAdmin, createAccount, createFetchHelper, createTestApp } from "./setup.js";
import type { Db } from "../src/db/client.js";
import type { Env } from "../src/env.js";
import { serviceCredentials, users } from "../src/db/schema.js";

// Only the network-touching seams are mocked. The credential/user join, the
// admin selection and the skip decision are all the real code path.
vi.mock("../src/lib/hardcover/matching.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/hardcover/matching.js")>()),
  matchBooksToHardcover: vi.fn().mockResolvedValue({ matched: 0, skipped: 0, failed: 0 }),
  backfillEditionPageCounts: vi.fn().mockResolvedValue({ updated: 0, skipped: 0, failed: 0 }),
}));
vi.mock("../src/lib/hardcover/client.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/hardcover/client.js")>()),
  verifyToken: vi.fn(),
}));
vi.mock("../src/services/settings.js", async (orig) => ({
  ...(await orig<typeof import("../src/services/settings.js")>()),
  // Metadata on (the global phase under test), progress sync off (phase 2 would
  // only add per-user network calls that prove nothing here).
  isHardcoverMetadataEnabled: vi.fn().mockResolvedValue(true),
  isHardcoverSyncEnabled: vi.fn().mockResolvedValue(false),
}));
vi.mock("../src/shared/auth.js", async (orig) => ({
  ...(await orig<typeof import("../src/shared/auth.js")>()),
  // Identity unseal, so each seeded credential carries a token that names its
  // owner and the assertions can say WHOSE token was spent.
  unsealToken: vi.fn((sealed: string) => Promise.resolve(sealed)),
}));

import * as matching from "../src/lib/hardcover/matching.js";
import * as client from "../src/lib/hardcover/client.js";
import { processHardcoverSync, selectGlobalMetadataUser } from "../src/workers/hardcover-sync.js";

const testEnv = {
  API_SECRET_KEY: "test-secret-key-at-least-32-characters-long!!",
} as Env;

let $fetchRaw: ReturnType<typeof createFetchHelper>;
let testDb: Db;
let services: Awaited<ReturnType<typeof createTestApp>>["services"];

const fakeJob = { updateProgress: vi.fn(), log: vi.fn(), data: {} };

beforeAll(async () => {
  const testApp = await createTestApp();
  $fetchRaw = createFetchHelper(testApp.app);
  testDb = testApp.db;
  services = testApp.services;
  const { __setTestEnv } = await import("../src/env.js");
  __setTestEnv(testEnv);
});

beforeEach(async () => {
  await $fetchRaw("/__test/cleanup", { method: "POST" });
  vi.mocked(client.verifyToken).mockImplementation((token: string) =>
    Promise.resolve({ ok: true as const, data: { id: 1, username: `holder-of-${token}` } }),
  );
});

afterEach(async () => {
  vi.clearAllMocks();
  await testDb.delete(serviceCredentials);
  await $fetchRaw("/__test/cleanup", { method: "POST" });
});

/** Give a user a Hardcover credential whose sealed value is its own token. */
async function connectHardcover(userId: string, token: string) {
  await testDb.insert(serviceCredentials).values({
    service: "hardcover",
    userId,
    username: `hc-${token}`,
    passwordHash: token,
  });
}

/** Force a user's account creation time so "oldest admin" is unambiguous. */
async function setAccountCreatedAt(userId: string, when: Date) {
  await testDb.update(users).set({ createdAt: when }).where(eq(users.id, userId));
}

/** The token every global-phase call was made with, deduplicated. */
function tokensSpentOnGlobalPhase(): string[] {
  return [
    ...vi.mocked(matching.matchBooksToHardcover).mock.calls.map((call) => call[1]),
    ...vi.mocked(matching.backfillEditionPageCounts).mock.calls.map((call) => call[1]),
  ];
}

describe("selectGlobalMetadataUser", () => {
  const at = (iso: string) => new Date(iso);

  it("ignores non-admins entirely", () => {
    expect(
      selectGlobalMetadataUser([
        { userId: "u1", role: "user", accountCreatedAt: at("2020-01-01T00:00:00Z") },
        { userId: "u2", role: null, accountCreatedAt: at("2020-01-02T00:00:00Z") },
      ]),
    ).toBeNull();
  });

  it("picks the oldest admin, whatever order the rows arrive in", () => {
    const rows = [
      { userId: "u-new-admin", role: "admin", accountCreatedAt: at("2024-06-01T00:00:00Z") },
      { userId: "u-member", role: "user", accountCreatedAt: at("2019-01-01T00:00:00Z") },
      { userId: "u-old-admin", role: "admin", accountCreatedAt: at("2021-03-04T00:00:00Z") },
    ];
    expect(selectGlobalMetadataUser(rows)?.userId).toBe("u-old-admin");
    expect(selectGlobalMetadataUser([...rows].reverse())?.userId).toBe("u-old-admin");
  });

  it("breaks a timestamp tie on user id so the pick cannot drift between runs", () => {
    const same = at("2022-02-02T00:00:00Z");
    const rows = [
      { userId: "bbb", role: "admin", accountCreatedAt: same },
      { userId: "aaa", role: "admin", accountCreatedAt: same },
    ];
    expect(selectGlobalMetadataUser(rows)?.userId).toBe("aaa");
    expect(selectGlobalMetadataUser([...rows].reverse())?.userId).toBe("aaa");
  });
});

describe("scheduled Hardcover sync — whose quota funds the global phase", () => {
  it("spends an admin's token, not the first connected user's", async () => {
    // The member is deliberately the older account and is inserted first, so a
    // worker taking validUsers[0] takes theirs. That is the regression: before
    // the fix both assertions below failed, with "member-token" spent.
    const { userId: adminId } = await bootstrapAdmin(services, $fetchRaw);
    const { userId: memberId } = await createAccount(services, {
      email: "member@example.test",
      role: "user",
    });
    await setAccountCreatedAt(memberId, new Date("2019-01-01T00:00:00Z"));
    await connectHardcover(memberId, "member-token");
    await connectHardcover(adminId, "admin-token");

    await processHardcoverSync(fakeJob as never);

    const spent = tokensSpentOnGlobalPhase();
    expect(spent).not.toContain("member-token");
    expect(spent).toEqual(["admin-token", "admin-token"]);
  });

  it("skips the global phase when no admin has connected Hardcover", async () => {
    // The failure path is the one that matters: with an admin present but not
    // connected, falling back to the only available token would put the cost
    // back on a member. Nothing must run.
    await bootstrapAdmin(services, $fetchRaw);
    const { userId: memberId } = await createAccount(services, {
      email: "member@example.test",
      role: "user",
    });
    await connectHardcover(memberId, "member-token");

    await processHardcoverSync(fakeJob as never);

    // Asserted on the tokens rather than with `not.toHaveBeenCalled()`: the
    // first argument of both calls is the Drizzle instance, and pretty-printing
    // it in a failure diff exhausts the heap.
    expect(tokensSpentOnGlobalPhase()).toEqual([]);
  });

  it("picks the same admin every run when several admins have connected", async () => {
    const { userId: firstAdminId } = await bootstrapAdmin(services, $fetchRaw);
    const { userId: secondAdminId } = await createAccount(services, {
      email: "second-admin@example.test",
      role: "admin",
    });
    await setAccountCreatedAt(firstAdminId, new Date("2020-01-01T00:00:00Z"));
    await setAccountCreatedAt(secondAdminId, new Date("2023-01-01T00:00:00Z"));
    // Newer admin's credential row is inserted first, so row order and account
    // order disagree — only the deterministic rule can hold the pick steady.
    await connectHardcover(secondAdminId, "second-admin-token");
    await connectHardcover(firstAdminId, "first-admin-token");

    await processHardcoverSync(fakeJob as never);
    await processHardcoverSync(fakeJob as never);

    expect(tokensSpentOnGlobalPhase()).toEqual([
      "first-admin-token",
      "first-admin-token",
      "first-admin-token",
      "first-admin-token",
    ]);
  });
});
