import { describe, expect, it } from "vite-plus/test";
import { elementContent, getAttribute, indexOfTag, removeElements, scanTags } from "./scan.js";

const BIG = 1024 * 1024;

describe("scan.ts linear primitives", () => {
  it("scanTags finds every complete tag and nothing on a flood of unterminated opens", () => {
    expect([...scanTags("<item a='1'/><item>b", "item")].map((t) => t.text)).toEqual([
      "<item a='1'/>",
      "<item>",
    ]);

    const flood = "<item ".repeat(BIG / 6);
    const started = performance.now();
    expect([...scanTags(flood, "item")]).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("indexOfTag scans a flood of `<` characters in bounded time", () => {
    const started = performance.now();
    expect(indexOfTag("<".repeat(BIG), "<item", 0)).toBe(-1);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("does not require a closing `>` to terminate the scan", () => {
    expect([...scanTags("<item attr='x", "item")]).toEqual([]);
  });

  it("getAttribute ignores prefixed lookalikes and honors quoting", () => {
    const tag = `<image xlink:href="wrong" href = 'right'/>`;
    expect(getAttribute(tag, "href")).toBe("right");
    expect(getAttribute(tag, "xlink:href")).toBe("wrong");
    expect(getAttribute(tag, "src")).toBeUndefined();
    expect(getAttribute(`<image href=""/>`, "href")).toBeUndefined();
  });

  it("elementContent returns undefined when the close tag is missing", () => {
    expect(elementContent("<body><p>hi</p></body>", "body")).toBe("<p>hi</p>");
    expect(elementContent("<body><p>hi", "body")).toBeUndefined();
    expect(elementContent("<body/>", "body")).toBeUndefined();
  });

  it("removeElements drops paired elements and keeps the rest", () => {
    expect(removeElements("a<script>x()</script>b<style>c</style>d", ["script", "style"])).toBe(
      "a b d",
    );
  });
});
