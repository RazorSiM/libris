import { describe, expect, it } from "vite-plus/test";
import { escapeXml, stripXmlInvalidCharacters } from "./opds-xml.js";

describe("OPDS XML escaping", () => {
  it("escapes all five XML entities", () => {
    expect(escapeXml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });

  it("removes every XML 1.0-invalid control and preserves legal whitespace", () => {
    const illegal = Array.from({ length: 0x20 }, (_, code) =>
      code === 0x09 || code === 0x0a || code === 0x0d ? "" : String.fromCodePoint(code),
    ).join("");
    expect(stripXmlInvalidCharacters(`before${illegal}\t\n\rafter`)).toBe("before\t\n\rafter");
  });
});
