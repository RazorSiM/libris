/**
 * Escapes ILIKE wildcard characters (% and _) in a string so they are
 * treated as literals when used inside a PostgreSQL ILIKE pattern.
 * Uses backslash as the escape character (PostgreSQL default).
 */
export function escapeIlike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
