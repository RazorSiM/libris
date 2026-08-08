import { describe, expect, it } from "vite-plus/test";
import { buildProgressAggregate, emptyProgressAggregate } from "./progress-aggregate";

const blankAggregate = {
  bookId: "b1",
  startedAt: null,
  finishedAt: null,
  manualStatus: null,
  manualStartedAt: null,
  manualFinishedAt: null,
  manualPausedAt: null,
  manualSetAt: null,
  externalStatus: null,
  externalStatusSyncedAt: null,
} as const;

describe("buildProgressAggregate", () => {
  it("returns unread when nothing is recorded", () => {
    const result = buildProgressAggregate([], []);

    // A literal, not `emptyProgressAggregate()`: comparing the
    // function against the factory it delegates to means both can change
    // together and this test never notices.
    expect(result).toEqual({
      percentage: null,
      status: "unread",
      lastDevice: null,
      lastTimestamp: null,
      startedAt: null,
      finishedAt: null,
      pausedAt: null,
      manuallySet: false,
      externallySet: false,
    });
  });

  it("emptyProgressAggregate is that same shape", () => {
    // Pinned separately so the factory and its caller cannot drift silently.
    expect(emptyProgressAggregate()).toEqual(buildProgressAggregate([], []));
  });

  it("derives status from highest-percentage progress row when no manual override", () => {
    const result = buildProgressAggregate(
      [
        {
          bookId: "b1",
          percentage: "0.5000",
          device: "phone",
          timestamp: BigInt(Math.floor(Date.now() / 1000) - 60),
        },
        {
          bookId: "b1",
          percentage: "0.2000",
          device: "kindle",
          timestamp: BigInt(Math.floor(Date.now() / 1000)),
        },
      ],
      [],
    );
    expect(result.status).toBe("reading");
    expect(result.percentage).toBe(0.5);
    expect(result.lastDevice).toBe("phone");
    expect(result.manuallySet).toBe(false);
  });

  it("manual_status wins over computed status", () => {
    const result = buildProgressAggregate(
      [
        {
          bookId: "b1",
          percentage: "0.1000",
          device: "phone",
          timestamp: BigInt(Math.floor(Date.now() / 1000)),
        },
      ],
      [
        {
          ...blankAggregate,
          manualStatus: "finished",
          manualStartedAt: new Date("2026-01-01T00:00:00Z"),
          manualFinishedAt: new Date("2026-02-01T00:00:00Z"),
          manualSetAt: new Date("2026-02-02T00:00:00Z"),
        },
      ],
    );
    expect(result.status).toBe("finished");
    expect(result.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.finishedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(result.manuallySet).toBe(true);
    // Underlying percentage from sync is preserved.
    expect(result.percentage).toBe(0.1);
  });

  it("manual dates win over auto dates when both exist", () => {
    const result = buildProgressAggregate(
      [],
      [
        {
          ...blankAggregate,
          startedAt: new Date("2026-03-01T00:00:00Z"),
          finishedAt: new Date("2026-03-15T00:00:00Z"),
          manualStatus: "finished",
          manualStartedAt: new Date("2026-01-01T00:00:00Z"),
          manualFinishedAt: new Date("2026-02-01T00:00:00Z"),
          manualSetAt: new Date("2026-04-01T00:00:00Z"),
        },
      ],
    );
    expect(result.startedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.finishedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("falls back to auto dates when manual ones are null", () => {
    const result = buildProgressAggregate(
      [],
      [
        {
          ...blankAggregate,
          startedAt: new Date("2026-03-01T00:00:00Z"),
          finishedAt: new Date("2026-03-15T00:00:00Z"),
          manualStatus: "paused",
          manualPausedAt: new Date("2026-04-01T00:00:00Z"),
          manualSetAt: new Date("2026-04-01T00:00:00Z"),
        },
      ],
    );
    expect(result.startedAt).toBe("2026-03-01T00:00:00.000Z");
    expect(result.finishedAt).toBe("2026-03-15T00:00:00.000Z");
    expect(result.pausedAt).toBe("2026-04-01T00:00:00.000Z");
    expect(result.status).toBe("paused");
  });

  it("picks the most recent manual override when multiple aggregate rows exist", () => {
    const result = buildProgressAggregate(
      [],
      [
        {
          ...blankAggregate,
          manualStatus: "reading",
          manualStartedAt: new Date("2026-01-01T00:00:00Z"),
          manualSetAt: new Date("2026-01-15T00:00:00Z"),
        },
        {
          ...blankAggregate,
          manualStatus: "finished",
          manualStartedAt: new Date("2026-01-01T00:00:00Z"),
          manualFinishedAt: new Date("2026-02-01T00:00:00Z"),
          manualSetAt: new Date("2026-02-02T00:00:00Z"),
        },
      ],
    );
    expect(result.status).toBe("finished");
    expect(result.finishedAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("uses external_status when there is no local progress and no manual override", () => {
    const result = buildProgressAggregate(
      [],
      [
        {
          ...blankAggregate,
          externalStatus: "finished",
          externalStatusSyncedAt: new Date("2026-04-01T00:00:00Z"),
        },
      ],
    );
    expect(result.status).toBe("finished");
    expect(result.percentage).toBeNull();
    expect(result.manuallySet).toBe(false);
    expect(result.externallySet).toBe(true);
  });

  it("local computed status wins over external_status when local progress exists", () => {
    const result = buildProgressAggregate(
      [
        {
          bookId: "b1",
          percentage: "0.4000",
          device: "phone",
          timestamp: BigInt(Math.floor(Date.now() / 1000)),
        },
      ],
      [
        {
          ...blankAggregate,
          externalStatus: "finished",
          externalStatusSyncedAt: new Date("2026-04-01T00:00:00Z"),
        },
      ],
    );
    expect(result.status).toBe("reading");
    expect(result.externallySet).toBe(false);
  });

  it("manual_status still wins over external_status", () => {
    const result = buildProgressAggregate(
      [],
      [
        {
          ...blankAggregate,
          manualStatus: "paused",
          manualSetAt: new Date("2026-04-10T00:00:00Z"),
          externalStatus: "finished",
          externalStatusSyncedAt: new Date("2026-04-01T00:00:00Z"),
        },
      ],
    );
    expect(result.status).toBe("paused");
    expect(result.manuallySet).toBe(true);
    expect(result.externallySet).toBe(false);
  });

  it("picks the most recently synced external_status across rows", () => {
    const result = buildProgressAggregate(
      [],
      [
        {
          ...blankAggregate,
          externalStatus: "reading",
          externalStatusSyncedAt: new Date("2026-04-01T00:00:00Z"),
        },
        {
          ...blankAggregate,
          externalStatus: "finished",
          externalStatusSyncedAt: new Date("2026-04-10T00:00:00Z"),
        },
      ],
    );
    expect(result.status).toBe("finished");
  });
});
