import { describe, expect, it } from "vite-plus/test";
import { resolveTransportMode } from "./logger.js";

/**
 * libris-59m.33. The regression these pin: `E2E_TEST=1` selected the disabled
 * StructuredTransport, so the API emitted nothing under either E2E harness.
 * `.github/workflows/ci.yml` and `docker-compose.test.yml` both set
 * `NODE_ENV=development` + `E2E_TEST=1`, which is the row below that used to
 * return "silent" and now returns "pino".
 */
describe("resolveTransportMode", () => {
  it("keeps unit tests quiet", () => {
    expect(resolveTransportMode({ NODE_ENV: "test" })).toBe("silent");
    // Even if an E2E variable leaks into a unit run.
    expect(resolveTransportMode({ NODE_ENV: "test", E2E_TEST: "1" })).toBe("silent");
  });

  it("gives the E2E harness machine-readable logs, not silence", () => {
    // The assertion that fails against the old logger, which returned the
    // disabled transport for this exact environment.
    expect(resolveTransportMode({ NODE_ENV: "development", E2E_TEST: "1" })).toBe("pino");
  });

  it("keeps better-sqlite3 out of the E2E container", () => {
    // "pretty" is the only mode that imports @loglayer/transport-pretty-terminal
    // and, with it, better-sqlite3. E2E must never select it.
    expect(resolveTransportMode({ NODE_ENV: "development", E2E_TEST: "1" })).not.toBe("pretty");
    expect(resolveTransportMode({ NODE_ENV: "production", E2E_TEST: "1" })).not.toBe("pretty");
  });

  it("still gives an interactive dev terminal the pretty transport", () => {
    expect(resolveTransportMode({ NODE_ENV: "development" })).toBe("pretty");
    expect(resolveTransportMode({ NODE_ENV: "development", E2E_TEST: "" })).toBe("pretty");
  });

  it("logs structured output in production", () => {
    expect(resolveTransportMode({ NODE_ENV: "production" })).toBe("pino");
  });
});
