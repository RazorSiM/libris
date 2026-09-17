/**
 * Linear, streaming-friendly XML/HTML scanners.
 *
 * These exist because the regexes they replaced (`<item[^>]+>`,
 * `<dc:\w+[^>]*>[\s\S]*?</dc:\w+>`, …) backtrack quadratically on crafted
 * input, and OPF/container documents reach these helpers before any size cap
 * the extractor applies to *fields*. Every function here makes a single
 * forward pass with no backtracking, so cost is linear in the input size.
 *
 * Element and attribute names are ASCII, so case folding is ASCII-only; that
 * is both sufficient and safer than `toLowerCase()`, which is locale-aware.
 */

const CHAR_GT = 0x3e; // ">"
const CHAR_SLASH = 0x2f; // "/"
const CHAR_EQUALS = 0x3d; // "="
const CHAR_DQUOTE = 0x22; // '"'
const CHAR_SQUOTE = 0x27; // "'"

export function isXmlSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function asciiLower(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

/**
 * True when `haystack` contains `needleLower` at `at`, folding ASCII letters.
 * `needleLower` must already be lowercase.
 */
function matchesAt(haystack: string, at: number, needleLower: string): boolean {
  if (at < 0 || at + needleLower.length > haystack.length) return false;
  for (let i = 0; i < needleLower.length; i++) {
    if (asciiLower(haystack.charCodeAt(at + i)) !== needleLower.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Case-insensitive `indexOf` for a needle beginning with "<". Native
 * `indexOf("<")` skips between candidates, so the total cost is
 * O(haystack length x needle length) with no backtracking.
 */
export function indexOfTag(haystack: string, needleLower: string, from: number): number {
  const limit = haystack.length - needleLower.length;
  let i = Math.max(0, from);
  while (i <= limit) {
    const at = haystack.indexOf("<", i);
    if (at === -1 || at > limit) return -1;
    if (matchesAt(haystack, at, needleLower)) return at;
    i = at + 1;
  }
  return -1;
}

/** Case-insensitive `indexOf` for an arbitrary ASCII-lowercase needle. */
export function indexOfCaseInsensitive(
  haystack: string,
  needleLower: string,
  from: number,
): number {
  const limit = haystack.length - needleLower.length;
  for (let i = Math.max(0, from); i <= limit; i++) {
    if (matchesAt(haystack, i, needleLower)) return i;
  }
  return -1;
}

export interface XmlTag {
  /** Full source text of the tag, angle brackets included. */
  text: string;
  /** Index of "<". */
  start: number;
  /** Index just past ">". */
  end: number;
}

/**
 * Iterate every `<name ...>` tag in `xml`, case-insensitively. `name` must be
 * lowercase. `<items>` does not match a scan for `item`. Linear in `xml.length`
 * because the cursor only ever moves forward.
 */
export function* scanTags(xml: string, name: string): Generator<XmlTag> {
  const open = `<${name}`;
  let pos = 0;
  while (pos < xml.length) {
    const start = indexOfTag(xml, open, pos);
    if (start === -1) return;
    const after = start + open.length;
    const next = after < xml.length ? xml.charCodeAt(after) : -1;
    if (next !== CHAR_GT && next !== CHAR_SLASH && !isXmlSpace(next)) {
      pos = start + 1;
      continue;
    }
    const gt = xml.indexOf(">", after);
    if (gt === -1) return;
    yield { text: xml.slice(start, gt + 1), start, end: gt + 1 };
    pos = gt + 1;
  }
}

/**
 * Read an attribute value out of a single tag's source text. `name` must be
 * lowercase; the attribute name must start at a whitespace boundary, so a scan
 * for `href` does not pick up `xlink:href`. Returns undefined for absent or
 * empty values, matching the `("[^"]+")` regexes this replaces.
 */
export function getAttribute(tag: string, name: string): string | undefined {
  for (let i = 1; i + name.length < tag.length; i++) {
    if (!isXmlSpace(tag.charCodeAt(i - 1))) continue;
    if (!matchesAt(tag, i, name)) continue;
    let j = i + name.length;
    while (j < tag.length && isXmlSpace(tag.charCodeAt(j))) j++;
    if (tag.charCodeAt(j) !== CHAR_EQUALS) continue;
    j++;
    while (j < tag.length && isXmlSpace(tag.charCodeAt(j))) j++;
    const quote = tag.charCodeAt(j);
    if (quote !== CHAR_DQUOTE && quote !== CHAR_SQUOTE) continue;
    const close = tag.indexOf(quote === CHAR_DQUOTE ? '"' : "'", j + 1);
    if (close === -1) return undefined;
    const value = tag.slice(j + 1, close);
    return value.length > 0 ? value : undefined;
  }
  return undefined;
}

/**
 * Text between the first `<name ...>` and its `</name>`. Returns undefined when
 * either is missing. A failed close-tag search ends the scan rather than
 * retrying later open tags: any later tag starts after the failed search
 * window, so it could not find a close tag either.
 */
export function elementContent(xml: string, name: string): string | undefined {
  for (const tag of scanTags(xml, name)) {
    if (tag.text.endsWith("/>")) continue;
    const close = indexOfTag(xml, `</${name}>`, tag.end);
    if (close === -1) return undefined;
    return xml.slice(tag.end, close);
  }
  return undefined;
}

/** Drop `<name>...</name>` elements (content included), replacing each with a space. */
export function removeElements(html: string, names: readonly string[]): string {
  let result = html;
  for (const name of names) {
    const closeTag = `</${name}>`;
    let out = "";
    let pos = 0;
    for (const tag of scanTags(result, name)) {
      if (tag.start < pos) continue; // already inside a removed region
      const close = indexOfTag(result, closeTag, tag.end);
      if (close === -1) break;
      out += `${result.slice(pos, tag.start)} `;
      pos = close + closeTag.length;
    }
    if (pos > 0) result = out + result.slice(pos);
  }
  return result;
}
