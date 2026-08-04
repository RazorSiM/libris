import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { getLogger } from "../lib/logger.js";
import type { AppVariables } from "../context.js";
import { deniesAppPasswords, resolvePolicy } from "../shared/route-policy.js";
import { requireKosyncAuth } from "../shared/kosync-auth.js";
import { withTrustedClientIp } from "../shared/request-ip.js";
import { isAdmin } from "../shared/auth.js";
import { apiKeyFromHeaders } from "../lib/auth.js";

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
    logger.warn(`Auth failure from ${c.get("clientIp")}`);
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
      .getSession({ headers: withTrustedClientIp(c.req.raw.headers, c.get("clientIp")) })
      .catch(() => null as Awaited<ReturnType<typeof auth.api.getSession>>);

    if (!session) {
      if (required) throw unauthorized();
      return;
    }

    c.set("userId", session.user.id);
    c.set("userName", session.user.name);
    c.set("role", session.user.role ?? undefined);
  };

  /**
   * How much authority this credential is allowed to carry.
   *
   * An app password resolves into a full session, so without this an OPDS
   * credential copied off an e-reader is its owner — admin included. The check
   * sits before the switch rather than inside each branch because it has to
   * cover "skip" too: /api/auth/* is the most sensitive prefix in the app and
   * the one the middleware otherwise stands aside for entirely.
   *
   * The signal is the credential the caller PRESENTED, not anything on the
   * resolved session — the plugin's before-hook builds a session that is
   * indistinguishable from a cookie one, and it overrides the cookie whenever a
   * key is present. Asking apiKeyFromHeaders (the very getter the plugin is
   * configured with) is the same question the plugin asked, so the two cannot
   * disagree about what this request is.
   *
   * Refusing before authenticating means a garbage key on /api/jobs is a 403
   * rather than a 401. That is the honest answer: the route does not take app
   * passwords, valid or otherwise, and saying so reveals nothing about the key.
   *
   * Edge case, accepted: a browser that has been through the native Basic
   * dialog on /opds may attach that Authorization header to same-origin /api/*
   * requests, and the plugin would already have preferred it over the cookie.
   * Such a request is refused here with a message that names the cause.
   */
  if ((policy === "admin" || deniesAppPasswords(path)) && apiKeyFromHeaders(c.req.raw.headers)) {
    logger.warn(`App password refused on ${path} from ${c.get("clientIp")}`);
    throw new HTTPException(403, {
      message: "App passwords cannot be used here — sign in for this",
    });
  }

  switch (policy) {
    case "skip":
      break;

    case "public":
      break;

    case "optional":
      await resolveSession(false);
      break;

    case "test": {
      const actual = Buffer.from(c.req.header("x-test-token") ?? "");
      const expected = Buffer.from(env.TEST_ROUTE_TOKEN ?? "");
      if (
        expected.length < 32 ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        throw unauthorized();
      }
      break;
    }

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
    //. No branch of its own any more.
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
