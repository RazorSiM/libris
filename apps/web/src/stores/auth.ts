import { defineStore } from "pinia";
import { ref } from "vue";

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

  return { authenticated, checked, admin, userId, name, email };
});
