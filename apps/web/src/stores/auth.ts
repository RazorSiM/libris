import { defineStore } from "pinia";
import { ref } from "vue";

export const useAuthStore = defineStore("auth", () => {
  const authenticated = ref(false);
  const checked = ref(false);
  const admin = ref(false);
  const label = ref<string | null>(null);
  const keyId = ref<string | null>(null);

  return { authenticated, checked, admin, label, keyId };
});
