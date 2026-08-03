import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/vue";
import { apiKeyClient } from "@better-auth/api-key/client";

/**
 * The Better Auth browser client.
 *
 * Mounting the handler as a catch-all in the API (`/api/auth/*`) means those
 * paths contribute nothing to Hono's RPC type graph, so there is no typed
 * `client.api.auth.*` for them. This client is the replacement, and it is the
 * ONLY place in the app that talks to Better Auth directly — everything else
 * goes through useAuth(), so a future change of transport touches one file.
 *
 * Plugins must mirror the server's (services/api-hono/src/lib/auth.ts) or the
 * client will not expose their endpoints.
 *
 * No baseURL: the SPA is served same-origin in production, and in dev Vite
 * proxies /api to the backend. A fixed value would break one of the two.
 */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [adminClient(), apiKeyClient()],
});

/**
 * A Better Auth client result, reduced to the value or a throw.
 *
 * The client resolves rather than rejects on a rejected request, so a caller
 * that forgets to read `.error` treats a refusal as a success. Funnelling every
 * call through here makes that impossible.
 */
export function unwrapAuthResult<T>(result: {
  data: T | null;
  error?: { message?: string; code?: string } | null;
}): T {
  if (result.error) throw new AuthRequestError(result.error);
  if (result.data === null) throw new Error("Request returned no data");
  return result.data;
}

/**
 * Carries Better Auth's error `code` alongside the message.
 *
 * The message is written for a generic auth UI; the code is stable and lets a
 * call site say something specific to what the user was actually doing.
 */
export class AuthRequestError extends Error {
  readonly code: string | undefined;

  constructor(error: { message?: string; code?: string }) {
    super(error.message ?? "Request failed");
    this.name = "AuthRequestError";
    this.code = error.code;
  }
}
