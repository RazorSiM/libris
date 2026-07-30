import { describe, expect, it } from "vite-plus/test";
import { computeReadingStatus, FINISHED_THRESHOLD, PAUSED_DAYS } from "./reading-status";

// ── computeReadingStatus (pure function) ─────────────────────────────────────
// The DB-backed functions (getReadingStatusCounts, getBooksByReadingStatus)
// are covered by E2E tests (reading-status.spec.ts) and api.test.ts.

describe("computeReadingStatus", () => {
  it("returns 'unread' for null percentage", () => {
    expect(computeReadingStatus(null, null)).toBe("unread");
  });

  it("returns 'unread' for 0 percentage", () => {
    expect(computeReadingStatus(0, null)).toBe("unread");
  });

  it("returns 'finished' at FINISHED_THRESHOLD", () => {
    expect(computeReadingStatus(FINISHED_THRESHOLD, new Date())).toBe("finished");
    expect(computeReadingStatus(1.0, new Date())).toBe("finished");
  });

  it("returns 'reading' for recent activity below threshold", () => {
    const recentDate = new Date(Date.now() - 24 * 60 * 60 * 1000); // yesterday
    expect(computeReadingStatus(0.5, recentDate)).toBe("reading");
  });

  it("returns 'paused' when lastActivityAt is null but progress > 0", () => {
    expect(computeReadingStatus(0.5, null)).toBe("paused");
  });

  it("returns 'paused' when inactive beyond PAUSED_DAYS", () => {
    const oldDate = new Date(Date.now() - (PAUSED_DAYS + 1) * 24 * 60 * 60 * 1000);
    expect(computeReadingStatus(0.5, oldDate)).toBe("paused");
  });

  it("returns 'reading' when active just within PAUSED_DAYS", () => {
    const recentDate = new Date(Date.now() - (PAUSED_DAYS - 1) * 24 * 60 * 60 * 1000);
    expect(computeReadingStatus(0.5, recentDate)).toBe("reading");
  });
});
