import { describe, expect, it } from "vite-plus/test";
import { ApproveBookBodySchema, LibraryPatchBodySchema } from "./schemas.js";

describe("persisted cover URL validation", () => {
  it.each([
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "file:///tmp/cover.jpg",
    "not a url",
    "https://user:password@example.com/cover.jpg",
  ])("rejects %s at patch and approved-metadata boundaries", (coverUrl) => {
    expect(LibraryPatchBodySchema.safeParse({ coverUrl }).success).toBe(false);
    expect(
      ApproveBookBodySchema.safeParse({
        fields: { coverUrl: { source: "test", value: coverUrl } },
      }).success,
    ).toBe(false);
  });

  it.each(["http://covers.example.test/a.jpg", "https://covers.example.test/a.jpg", null])(
    "accepts %s",
    (coverUrl) => {
      expect(LibraryPatchBodySchema.safeParse({ coverUrl }).success).toBe(true);
      expect(
        ApproveBookBodySchema.safeParse({
          fields: { coverUrl: { source: "test", value: coverUrl } },
        }).success,
      ).toBe(true);
    },
  );
});
