/**
 * Free text → the prefix tsquery the four search endpoints hand to Postgres.
 *
 * `to_tsquery` parses an expression language, not text, and the four routes
 * each carried their own regex that missed the apostrophe. A caller typing
 * `foo&'` produced `foo & ':*` and Postgres answered `syntax error in tsquery`
 * — a 500 from /api/search, /api/library, /api/inbox and /opds/search alike.
 */
export function buildPrefixTsquery(input: string): string | null {
  const sanitized = input
    // Apostrophes are quote characters to tsquery, but to a reader they are
    // part of the word: dropping them keeps `children's` a single lexeme for
    // the English stemmer instead of splitting it into `children & s:*`.
    .replaceAll(/['’]/g, "")
    // Everything else tsquery treats as syntax becomes a word separator. `-`
    // and `\` are not errors but do change meaning (phrase operator, escape),
    // so they go too.
    .replaceAll(/[&|!<>():*\\"-]/g, " ")
    .trim();
  if (!sanitized) return null;

  const words = sanitized.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  // Prefix-match the final word, which is what a search-as-you-type caller
  // expects; earlier words must match whole.
  return words.map((word, index) => (index === words.length - 1 ? `${word}:*` : word)).join(" & ");
}
