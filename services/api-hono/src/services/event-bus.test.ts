import { afterEach, describe, expect, it } from "vite-plus/test";
import { onServerEvent, publishEvent } from "./event-bus.js";

describe("event bus subscriber scoping", () => {
  const unsubscribers: Array<() => void> = [];

  afterEach(() => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  });

  it("delivers a book event only to its owner and administrators", async () => {
    const ownerEvents: string[] = [];
    const otherUserEvents: string[] = [];
    const adminEvents: string[] = [];

    unsubscribers.push(
      onServerEvent((event) => ownerEvents.push(event.type), { userId: "owner", isAdmin: false }),
      onServerEvent((event) => otherUserEvents.push(event.type), {
        userId: "other",
        isAdmin: false,
      }),
      onServerEvent((event) => adminEvents.push(event.type), { userId: "admin", isAdmin: true }),
    );

    await publishEvent({ type: "book:detected", bookId: "book-1", userId: "owner" });

    expect(ownerEvents).toEqual(["book:detected"]);
    expect(otherUserEvents).toEqual([]);
    expect(adminEvents).toEqual(["book:detected"]);
  });

  it("keeps unscoped operational events admin-only", async () => {
    const userEvents: string[] = [];
    const adminEvents: string[] = [];

    unsubscribers.push(
      onServerEvent((event) => userEvents.push(event.type), { userId: "user", isAdmin: false }),
      onServerEvent((event) => adminEvents.push(event.type), { userId: "admin", isAdmin: true }),
    );

    await publishEvent({ type: "hardcover:sync-progress" });

    expect(userEvents).toEqual([]);
    expect(adminEvents).toEqual(["hardcover:sync-progress"]);
  });
});
