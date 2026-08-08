import { describe, expect, test } from "vite-plus/test";
import { sanitizeMetadata, stripHtml } from "./sanitize.js";

describe("stripHtml", () => {
  test("removes HTML tags", () => {
    expect(stripHtml("<b>bold</b> text")).toBe("bold text");
  });

  test("decodes HTML entities", () => {
    expect(stripHtml("&lt;script&gt;alert(1)&lt;/script&gt;")).toBe("alert(1)");
  });

  test("converts <br> to newlines", () => {
    expect(stripHtml("line1<br>line2<br/>line3")).toBe("line1\nline2\nline3");
  });

  test("converts </p> to newlines", () => {
    expect(stripHtml("<p>para1</p><p>para2</p>")).toBe("para1\npara2");
  });

  test("collapses excessive newlines", () => {
    expect(stripHtml("a<br><br><br><br>b")).toBe("a\n\nb");
  });

  test("trims whitespace", () => {
    expect(stripHtml("  <span>hello</span>  ")).toBe("hello");
  });

  test("handles empty string", () => {
    expect(stripHtml("")).toBe("");
  });

  test("handles plain text without HTML", () => {
    expect(stripHtml("just plain text")).toBe("just plain text");
  });

  test("removes XML-invalid control characters", () => {
    expect(stripHtml("clean\u0001dirty\u000Btext\u001F")).toBe("cleandirtytext");
  });

  test("strips script tags", () => {
    expect(stripHtml('<script>alert("xss")</script>safe')).toBe('alert("xss")safe');
  });

  test("strips img/iframe tags", () => {
    expect(stripHtml('<img src="x" onerror="alert(1)">text')).toBe("text");
    expect(stripHtml('<iframe src="evil.com"></iframe>content')).toBe("content");
  });

  test("decodes &nbsp; to space", () => {
    expect(stripHtml("word1&nbsp;word2")).toBe("word1 word2");
  });

  test("decodes &quot; and &#39;", () => {
    expect(stripHtml("&quot;quoted&quot; and &#39;apostrophe&#39;")).toBe(
      "\"quoted\" and 'apostrophe'",
    );
  });
});

describe("sanitizeMetadata", () => {
  test("strips HTML from title", () => {
    const result = sanitizeMetadata({ title: "<b>My Book</b>" });
    expect(result.title).toBe("My Book");
  });

  test("strips HTML from author", () => {
    const result = sanitizeMetadata({ author: "<i>John Doe</i>" });
    expect(result.author).toBe("John Doe");
  });

  test("strips HTML from publisher", () => {
    const result = sanitizeMetadata({ publisher: "Penguin&amp;Random" });
    expect(result.publisher).toBe("Penguin&Random");
  });

  test("strips HTML from description", () => {
    const result = sanitizeMetadata({
      description: "<p>A <b>great</b> book about <i>things</i>.</p>",
    });
    expect(result.description).toBe("A great book about things.");
  });

  test("strips HTML from genres", () => {
    const result = sanitizeMetadata({
      genres: ["<b>Fiction</b>", "Science &amp; Tech", "<script>alert(1)</script>"],
    });
    expect(result.genres).toEqual(["Fiction", "Science & Tech", "alert(1)"]);
  });

  test("preserves non-text fields", () => {
    const result = sanitizeMetadata({
      title: "Clean Title",
      isbn10: "0123456789",
      isbn13: "9780123456789",
      publishedYear: 2024,
      pageCount: 300,
      coverUrl: "https://example.com/cover.jpg",
      language: "en",
    });
    expect(result.isbn10).toBe("0123456789");
    expect(result.isbn13).toBe("9780123456789");
    expect(result.publishedYear).toBe(2024);
    expect(result.pageCount).toBe(300);
    expect(result.coverUrl).toBe("https://example.com/cover.jpg");
    expect(result.language).toBe("en");
  });

  test("sets empty-after-strip fields to undefined", () => {
    const result = sanitizeMetadata({ title: "<b></b>", author: "  <i> </i>  " });
    expect(result.title).toBeUndefined();
    expect(result.author).toBeUndefined();
  });

  test("filters empty genres after stripping", () => {
    const result = sanitizeMetadata({ genres: ["<b></b>", "Valid", "  <i> </i>  "] });
    expect(result.genres).toEqual(["Valid"]);
  });

  test("handles undefined fields gracefully", () => {
    const result = sanitizeMetadata({
      title: undefined,
      author: undefined,
      description: undefined,
      genres: undefined,
    });
    expect(result.title).toBeUndefined();
    expect(result.author).toBeUndefined();
    expect(result.description).toBeUndefined();
    expect(result.genres).toBeUndefined();
  });

  test("sanitizes HTML description", () => {
    const result = sanitizeMetadata({
      description:
        "A <b>New York Times</b> bestseller. &quot;Brilliant&quot; &mdash; <i>The Guardian</i>",
    });
    expect(result.description).not.toContain("<b>");
    expect(result.description).not.toContain("<i>");
    expect(result.description).toContain("New York Times");
    expect(result.description).toContain("The Guardian");
  });
});
