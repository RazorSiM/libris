/**
 * The one definition of "this account is currently banned".
 *
 * Banning is the only revocation an admin can perform short of deleting the
 * account, and it has to hold on every credential path — cookie session, app
 * password and KoSync alike. Three copies of a three-line
 * predicate is three chances for one of them to drift, so both enforcement
 * points call this.
 *
 * The semantics match Better Auth's own check in
 * `plugins/admin/admin.mjs` (the session-create hook): `banned` is only
 * effective while `banExpires` is absent or still in the future. A ban whose
 * window has passed is not a ban.
 *
 * `banExpires` is typed loosely on purpose. It arrives as a Date from the
 * Drizzle adapter on the app-password path and as an ISO string from the
 * JSON-serialised session snapshot in secondary storage, and a predicate that
 * silently failed open on one of those shapes would be the whole bug again.
 */
export interface BannableUser {
  banned?: boolean | null | undefined;
  banExpires?: Date | string | number | null | undefined;
}

export function isUserBanned(user: BannableUser, now: number = Date.now()): boolean {
  if (user.banned !== true) return false;
  if (user.banExpires === null || user.banExpires === undefined) return true;

  const expiresAt = new Date(user.banExpires).getTime();
  // An unparseable expiry is not a licence to let the user back in.
  if (Number.isNaN(expiresAt)) return true;
  return expiresAt > now;
}
