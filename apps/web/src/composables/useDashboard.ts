import { createSharedComposable } from "@vueuse/core";

const _useDashboard = () => {
  const router = useRouter();
  const showShortcuts = ref(false);

  defineShortcuts({
    "?": () => {
      showShortcuts.value = !showShortcuts.value;
    },
    "g-h": () => router.push("/"),
    "g-i": () => router.push("/inbox"),
    "g-l": () => router.push("/library"),
    "g-s": () => router.push("/settings"),
  });

  return { showShortcuts };
};

export const useDashboard = createSharedComposable(_useDashboard);
