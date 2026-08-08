import { defineStore } from "pinia";
import { ref, shallowRef } from "vue";

/**
 * Who the app believes is signed in — the single copy of it.
 *
 * useAuth() is a plain function with no memoisation, so every call site gets a
 * fresh closure. Anything that has to agree ACROSS call sites therefore has to
 * live here, and that includes the two fields below, which are not display
 * state at all but the machinery that keeps the display state honest.
 */
export const useAuthStore = defineStore("auth", () => {
  const authenticated = ref(false);
  const checked = ref(false);
  const admin = ref(false);
  const userId = ref<string | null>(null);
  // Kept apart rather than as one display string: the account page edits the
  // name and shows the address beside it, and it cannot take either back out
  // of "Ada" or "ada@example.com".
  const name = ref<string | null>(null);
  const email = ref<string | null>(null);

  /**
   * Bumped by anything that changes WHO is signed in.
   *
   * A session request already on the wire carries the previous identity. When
   * it lands it compares the generation it was issued under against this one,
   * and a mismatch means it is describing a session that no longer exists — so
   * it is dropped rather than written back over the sign-out that overtook it.
   *
   * This lived inside useAuth() until 2026-08-08, where it was a per-closure
   * counter: logout() bumped its own copy, and the in-flight check() started by
   * a DIFFERENT useAuth() compared against an untouched one, passed, and signed
   * the user back in. It has to be shared to guard anything.
   */
  const generation = ref(0);
  /** The one session request in flight, shared so N callers make one request. */
  const inFlight = shallowRef<Promise<void> | null>(null);

  return { authenticated, checked, admin, userId, name, email, generation, inFlight };
});
