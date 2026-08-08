// @vitest-environment happy-dom
/**
 * Credential mutations, driven against a REAL useApiClient().
 *
 * The claim under test is that a rejected save renders a success toast. That
 * turns entirely on whether the Hono RPC call rejects, so nothing here stubs
 * the client: the only thing replaced is the network, and the assertion is on
 * what the caller — SettingsKosync's try/catch — actually sees.
 *
 * A 409 is the case that matters. `PUT /api/credentials/kosync` answers one
 * when the KoSync username is already claimed by somebody else, with a message
 * written for the user, and a mutation that resolves anyway would tell them the
 * credential saved when it did not.
 */
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface MutationOptions {
  mutation: (vars: never) => Promise<unknown>;
  onSettled?: () => unknown;
}

const invalidateQueries = vi.fn();
const captured: MutationOptions[] = [];

vi.mock("@pinia/colada", () => ({
  useMutation: (options: MutationOptions) => {
    captured.push(options);
    return { mutateAsync: options.mutation };
  },
  useQueryCache: () => ({ invalidateQueries }),
}));

const { useApiClient, ApiError } = await import("~/composables/useApiClient");
Object.assign(globalThis, { useApiClient });

const { usePutCredential, useDeleteCredential } = await import("./useCredentialMutations");

/** The options a composable handed useMutation. */
function optionsOf(composable: () => unknown): MutationOptions {
  captured.length = 0;
  composable();
  const options = captured[0];
  if (!options) throw new Error("useMutation was never called");
  return options;
}

/** Answer the next request with this status and body, and record the call. */
function respondWith(status: number, body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const KOSYNC = { service: "kosync", username: "ada", password: "hunter2" } as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("usePutCredential()", () => {
  it("rejects with the server's message when the username is taken", async () => {
    // The 409 body the credentials route returns for a claimed username. If
    // this resolves, SettingsKosync's catch never runs and the user is shown
    // "KoSync credentials saved" for a credential that was refused.
    respondWith(409, { error: "That KoSync username is already registered" });

    await expect(optionsOf(usePutCredential).mutation(KOSYNC as never)).rejects.toThrow(
      /already registered/,
    );
  });

  it("rejects with an ApiError carrying the status", async () => {
    // The status is what lets a call site say something specific; collapsing
    // every failure into a bare Error throws that away.
    respondWith(409, { error: "That KoSync username is already registered" });

    await expect(optionsOf(usePutCredential).mutation(KOSYNC as never)).rejects.toMatchObject({
      name: "ApiError",
      status: 409,
    });
    expect(ApiError).toBeTypeOf("function");
  });

  it("rejects on a 500 with no JSON body rather than resolving", async () => {
    const fetchMock = vi.fn(async () => new Response("upstream exploded", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(optionsOf(usePutCredential).mutation(KOSYNC as never)).rejects.toThrow(
      /upstream exploded/,
    );
  });

  it("resolves on success", async () => {
    respondWith(200, { success: true });

    await expect(optionsOf(usePutCredential).mutation(KOSYNC as never)).resolves.toBeUndefined();
  });
});

describe("useDeleteCredential()", () => {
  it("rejects rather than reporting a disconnect that did not happen", async () => {
    respondWith(404, { error: "No kosync credential to remove" });

    await expect(optionsOf(useDeleteCredential).mutation("kosync" as never)).rejects.toThrow(
      /No kosync credential/,
    );
  });

  it("resolves on success", async () => {
    respondWith(200, { success: true });

    await expect(
      optionsOf(useDeleteCredential).mutation("kosync" as never),
    ).resolves.toBeUndefined();
  });
});
