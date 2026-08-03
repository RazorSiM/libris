/**
 * Turn a User-Agent header into something a person can recognise.
 *
 * The device list exists so someone can spot a session they do not recognise,
 * and a raw UA string is the worst possible format for that job — the useful
 * words are buried among version numbers and two decades of compatibility
 * tokens. This reduces it to "Chrome on macOS".
 *
 * Deliberately not a UA-parsing library. Those carry large, frequently-updated
 * databases to answer questions this app never asks; here the answer only has
 * to be good enough to recognise your own laptop, and an unknown string falls
 * back to the raw value rather than guessing.
 *
 * Order matters in both tables below. Every Chromium browser also claims to be
 * Safari, Edge claims to be Chrome, and almost everything claims to be Mozilla,
 * so the most specific brand has to be tested first.
 */

interface Rule {
  readonly label: string;
  readonly match: RegExp;
}

const BROWSERS: readonly Rule[] = [
  { label: "Edge", match: /\bEdg(?:e|A|iOS)?\// },
  { label: "Opera", match: /\bOPR\/|\bOpera\// },
  { label: "Samsung Internet", match: /\bSamsungBrowser\// },
  { label: "Firefox", match: /\bFirefox\/|\bFxiOS\// },
  { label: "Chrome", match: /\bChrome\/|\bCriOS\// },
  { label: "Safari", match: /\bSafari\// },
  // Not browsers, but the things most likely to be holding a session here
  // besides a browser — and "unknown device" would be a worse answer.
  { label: "KOReader", match: /\bKOReader\b/i },
  { label: "curl", match: /^curl\//i },
];

const PLATFORMS: readonly Rule[] = [
  { label: "iPhone", match: /\biPhone\b/ },
  { label: "iPad", match: /\biPad\b/ },
  { label: "Android", match: /\bAndroid\b/ },
  // Before macOS: an Intel Mac UA contains "Mac OS X", and a Kindle or Kobo
  // browser can carry a Linux token alongside its own.
  { label: "Kindle", match: /\bKindle\b|\bSilk\// },
  { label: "Kobo", match: /\bKobo\b/i },
  { label: "macOS", match: /\bMac OS X\b|\bMacintosh\b/ },
  { label: "Windows", match: /\bWindows\b/ },
  { label: "Linux", match: /\bLinux\b|\bX11\b/ },
];

function firstMatch(rules: readonly Rule[], value: string): string | null {
  return rules.find((rule) => rule.match.test(value))?.label ?? null;
}

/**
 * A short human label for a User-Agent, e.g. "Firefox on Linux".
 *
 * Returns the raw string when nothing matches, and "Unknown device" only when
 * there is nothing to show at all — a session with no UA is still a session
 * somebody may want to revoke, so it must not be rendered blank.
 */
export function describeUserAgent(userAgent: string | null | undefined): string {
  const value = userAgent?.trim();
  if (!value) return "Unknown device";

  const browser = firstMatch(BROWSERS, value);
  const platform = firstMatch(PLATFORMS, value);

  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? platform ?? value;
}

/** An icon that matches what describeUserAgent() decided this thing is. */
export function userAgentIcon(userAgent: string | null | undefined): string {
  const value = userAgent?.trim() ?? "";
  if (/\biPhone\b|\bAndroid\b/.test(value)) return "i-lucide-smartphone";
  if (/\biPad\b/.test(value)) return "i-lucide-tablet";
  if (/\bKindle\b|\bKobo\b|\bKOReader\b/i.test(value)) return "i-lucide-book-open";
  if (!value) return "i-lucide-circle-help";
  return "i-lucide-monitor";
}
