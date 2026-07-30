import type { Context } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { sealToken, unsealToken } from "./auth.js";
import type { AppVariables } from "../context.js";

const COOKIE_NAME = "books-auth";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

interface SessionData {
  apiKey: string;
}

function cookieOptions(c: Context<{ Variables: AppVariables }>) {
  const env = c.get("env");
  const isProduction = env.NODE_ENV === "production";
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: isProduction,
    path: "/",
    maxAge: COOKIE_MAX_AGE,
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export async function writeSession(
  c: Context<{ Variables: AppVariables }>,
  data: SessionData,
): Promise<void> {
  const secret = c.get("env").API_SECRET_KEY;
  const token = await sealToken(JSON.stringify(data), secret);
  setCookie(c, COOKIE_NAME, token, cookieOptions(c));
}

export async function readSession(
  c: Context<{ Variables: AppVariables }>,
): Promise<SessionData | null> {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) return null;

  const secret = c.get("env").API_SECRET_KEY;
  const decrypted = await unsealToken(token, secret);
  if (!decrypted) return null;

  try {
    return JSON.parse(decrypted) as SessionData;
  } catch {
    return null;
  }
}

export function clearSession(c: Context<{ Variables: AppVariables }>): void {
  const env = c.get("env");
  const isProduction = env.NODE_ENV === "production";
  deleteCookie(c, COOKIE_NAME, {
    httpOnly: true,
    sameSite: "Lax",
    secure: isProduction,
    path: "/",
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  });
}
