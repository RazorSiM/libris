import type { LocationQueryValue } from "vue-router";

/**
 * Resolve the `?redirect=` the auth guard attached, or fall back to home.
 *
 * Only same-site absolute paths are honoured. A login form that follows
 * whatever URL arrives in a query parameter is an open redirect: an attacker
 * sends `/login?redirect=https://libris-phish.example`, the victim signs in on
 * the real site, and is handed straight to a copy that asks them to sign in
 * "again". The `//` case matters as much as the scheme one — `//evil.example`
 * is a protocol-relative URL, not a path.
 */
export function resolveRedirect(
  redirect: LocationQueryValue | LocationQueryValue[] | undefined,
  fallback = "/",
): string {
  const value = Array.isArray(redirect) ? redirect[0] : redirect;
  if (typeof value !== "string") return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  // A backslash is treated as a slash by some browsers when resolving a URL,
  // so /\evil.example can escape the origin the same way //evil.example does.
  if (value.startsWith("/\\")) return fallback;
  return value;
}
