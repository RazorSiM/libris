/**
 * Whether a Better Auth role value carries admin.
 *
 * The admin plugin stores multiple roles as a comma-joined string, and the API
 * parses membership rather than comparing equality. The UI must do the same: an
 * exact `=== "admin"` check shows an `admin,user` account as a plain user and
 * offers role actions the API will refuse.
 */
export function roleHasAdmin(role: string | string[] | null | undefined): boolean {
  const values = Array.isArray(role) ? role : [role];
  return values.some(
    (value) =>
      typeof value === "string" && value.split(",").some((part) => part.trim() === "admin"),
  );
}
