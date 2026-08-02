import { createMiddleware } from "hono/factory";
import { HTTPException } from "hono/http-exception";
import { getLogger } from "../lib/logger.js";
import type { AppVariables } from "../context.js";
import { resolvePolicy } from "../shared/route-policy.js";
import { requireKosyncAuth } from "../shared/kosync-auth.js";
import { getRequestIp } from "../shared/request-ip.js";
import { isAdmin } from "../shared/auth.js";

const logger = getLogger("auth");

/**
 * One session lookup for every kind of caller.
 *
 * This used to be a five-branch policy switch over a bespoke credential store,
 * fronted by a five-minute in-memory cache whose correctness depended on every
 * privilege-changing route remembering to call clearAuthCaches(). All of that
 * is gone. `enableSessionForAPIKeys` makes the apiKey plugin resolve a valid app
 * password into a session, so `getSession` answers for cookies and app passwords
 * alike, and the admin plugin puts the role on the user where it belongs.
 *
 * Nothing is cached here. Better Auth's own cookie cache is off (see lib/auth.ts),
 * so a revoked credential, a role change or a ban takes effect on the very next
 * request rather than up to five minutes later.
 *
 * KoSync is the one genuine exception: KOReader sends md5(password) in its own
 * x-auth-key header, which is not a Better Auth credential in any form.
 */
export const authMiddleware = createMiddleware<{ Variables: AppVariables }>(async (c, next) => {
  const path = c.req.path;
  const policy = resolvePolicy(path);
  const db = c.get("db");
  const env = c.get("env");
  const auth = c.get("auth");

  /**
   * An OPDS reader that gets a bare 401 shows the user an error; one that gets
   * a WWW-Authenticate challenge shows a login box. The header is the whole
   * difference between "Libris is broken" and "Libris wants my password".
   *
   * It is scoped to OPDS on purpose — sending it on /api/* would pop the
   * browser's native Basic dialog over the SPA.
   */
  const unauthorized = (): HTTPException => {
    logger.warn(`Auth failure from ${getRequestIp(c)}`);
    if (policy !== "opds") {
      return new HTTPException(401, { message: "Authentication required" });
    }
    // `message` still carries the body text: app.ts builds the JSON from it and
    // copies the headers off this response, so both survive.
    return new HTTPException(401, {
      message: "Authentication required",
      res: new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="Libris OPDS", charset="UTF-8"' },
      }),
    });
  };

  const resolveSession = async (required: boolean): Promise<void> => {
    // getSession returns null for "no credential presented", but THROWS an
    // APIError for a credential that was presented and rejected — an unknown or
    // disabled app password, most commonly. Both mean the same thing here, and
    // letting the throw escape would turn a bad key into a 500.
    const session = await auth.api
      .getSession({ headers: c.req.raw.headers })
      .catch(() => null as Awaited<ReturnType<typeof auth.api.getSession>>);

    if (!session) {
      if (required) throw unauthorized();
      return;
    }

    c.set("userId", session.user.id);
    c.set("userName", session.user.name);
    c.set("role", session.user.role ?? undefined);
  };

  switch (policy) {
    case "skip":
      if (
        path.startsWith("/__test/") &&
        !(env.NODE_ENV === "development" || env.NODE_ENV === "test" || env.E2E_TEST === "1")
      ) {
        throw new HTTPException(404, { message: "Not found" });
      }
      break;

    case "public":
      break;

    case "optional":
      await resolveSession(false);
      break;

    case "kosync": {
      if (path === "/kosync/users/auth" || path === "/kosync/users/create") break;
      const kosyncUserId = await requireKosyncAuth(
        {
          username: c.req.header("x-auth-user"),
          password: c.req.header("x-auth-key"),
        },
        db,
      );
      c.set("userId", kosyncUserId);
      break;
    }

    // OPDS clients send their app password over Basic auth, which a
    // customAPIKeyGetter turns into the same session everything else gets
    // (libris-5ng.12). No branch of its own any more.
    case "opds":
    case "api-key":
      await resolveSession(true);
      break;

    case "admin":
      await resolveSession(true);
      if (!isAdmin(c)) {
        throw new HTTPException(403, { message: "Admin access required" });
      }
      break;
  }

  await next();
});
