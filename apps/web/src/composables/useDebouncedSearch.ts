import { useDebounceFn } from "@vueuse/core";

export function useDebouncedSearch(delayMs = 300) {
  const search = ref("");
  const debouncedSearch = ref("");

  const flush = useDebounceFn((val: string) => {
    debouncedSearch.value = val;
  }, delayMs);

  watch(search, (val) => flush(val));

  return { search, debouncedSearch };
}
