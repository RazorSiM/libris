import { describe, expect, it } from "vite-plus/test";
import { describeUserAgent, userAgentIcon } from "./user-agent";

/**
 * Real User-Agent strings, not invented ones. The whole difficulty here is that
 * browsers lie about each other — every Chromium claims Safari, Edge claims
 * Chrome — and an invented string would quietly agree with whatever the
 * implementation happens to do.
 */
const AGENTS = {
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36",
  safariMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  edgeWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.2210.91",
  firefoxLinux: "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.144 Mobile Safari/537.36",
  ipadSafari:
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  koreader: "KOReader/2024.04",
  curl: "curl/8.21.0",
} as const;

describe("describeUserAgent", () => {
  it.each([
    [AGENTS.chromeMac, "Chrome on macOS"],
    [AGENTS.safariMac, "Safari on macOS"],
    [AGENTS.firefoxLinux, "Firefox on Linux"],
    [AGENTS.safariIphone, "Safari on iPhone"],
    [AGENTS.ipadSafari, "Safari on iPad"],
  ])("reads %# as the browser and platform a person would name", (agent, expected) => {
    expect(describeUserAgent(agent)).toBe(expected);
  });

  it("calls Edge Edge, not Chrome", () => {
    // Edge's UA contains "Chrome/120.0.0.0" verbatim. Testing Chrome first
    // would label every Edge session Chrome, and someone auditing their devices
    // would not find the one they were looking for.
    expect(describeUserAgent(AGENTS.edgeWindows)).toBe("Edge on Windows");
  });

  it("calls Android Android, though its UA also says Linux", () => {
    expect(describeUserAgent(AGENTS.chromeAndroid)).toBe("Chrome on Android");
  });

  it("names an e-reader rather than calling it an unknown device", () => {
    expect(describeUserAgent(AGENTS.koreader)).toBe("KOReader");
  });

  it("falls back to the raw string rather than guessing", () => {
    expect(describeUserAgent("SomeFutureBrowser/1.0")).toBe("SomeFutureBrowser/1.0");
  });

  it.each([[null], [undefined], [""], ["   "]])(
    "still names a session with no user agent (%s)",
    (agent) => {
      // A session with no UA is still a session someone may want to revoke, so
      // the row must not render blank.
      expect(describeUserAgent(agent)).toBe("Unknown device");
    },
  );
});

describe("userAgentIcon", () => {
  it.each([
    [AGENTS.safariIphone, "i-lucide-smartphone"],
    [AGENTS.chromeAndroid, "i-lucide-smartphone"],
    [AGENTS.ipadSafari, "i-lucide-tablet"],
    [AGENTS.koreader, "i-lucide-book-open"],
    [AGENTS.chromeMac, "i-lucide-monitor"],
    [AGENTS.curl, "i-lucide-monitor"],
  ])("picks an icon matching what %# is", (agent, expected) => {
    expect(userAgentIcon(agent)).toBe(expected);
  });

  it("has an icon for a session with no user agent", () => {
    expect(userAgentIcon(null)).toBe("i-lucide-circle-help");
  });
});
