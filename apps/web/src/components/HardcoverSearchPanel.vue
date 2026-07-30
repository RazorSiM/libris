<script setup lang="ts">
import type { HardcoverSearchHit } from "~/composables/useHardcoverSearch";

const { initialQuery } = defineProps<{
  initialQuery?: string;
}>();

const emit = defineEmits<{
  pick: [hit: HardcoverSearchHit];
}>();

const { query, results, loading, error } = useHardcoverSearch();

watchEffect(() => {
  if (initialQuery && !query.value) query.value = initialQuery;
});

function onPick(hit: HardcoverSearchHit) {
  emit("pick", hit);
}

function summarize(hit: HardcoverSearchHit): string {
  const parts: string[] = [];
  if (hit.normalized.author) parts.push(hit.normalized.author);
  if (hit.normalized.publishedYear) parts.push(String(hit.normalized.publishedYear));
  if (hit.normalized.pageCount) parts.push(`${hit.normalized.pageCount}p`);
  const isbn = hit.normalized.isbn13 ?? hit.normalized.isbn10;
  if (isbn) parts.push(isbn);
  return parts.join(" · ");
}
</script>

<template>
  <div class="space-y-3" data-testid="hardcover-search-panel">
    <UInput
      v-model="query"
      placeholder="Search Hardcover by title, author, or ISBN…"
      icon="i-lucide-search"
      class="w-full"
      data-testid="hardcover-search-input"
    />

    <div
      v-if="error?.kind === 'disabled'"
      data-testid="hardcover-search-disabled"
      class="text-sm text-muted py-3 px-3 rounded-md bg-elevated"
    >
      {{ error.message }}
    </div>

    <div
      v-else-if="error?.kind === 'network'"
      data-testid="hardcover-search-error"
      class="text-sm text-error py-3 px-3 rounded-md bg-elevated"
    >
      {{ error.message }}
    </div>

    <div
      v-else-if="loading"
      data-testid="hardcover-search-loading"
      class="flex items-center gap-2 text-sm text-muted py-3"
    >
      <UIcon name="i-lucide-loader-circle" class="animate-spin" />
      Searching…
    </div>

    <div
      v-else-if="query.trim().length >= 2 && results.length === 0"
      data-testid="hardcover-search-empty"
      class="text-sm text-muted py-3"
    >
      No matches on Hardcover.
    </div>

    <ul
      v-else-if="results.length > 0"
      class="space-y-2 max-h-[420px] overflow-y-auto"
      data-testid="hardcover-search-results"
    >
      <li v-for="(hit, idx) in results" :key="idx">
        <button
          type="button"
          class="w-full flex gap-3 items-start text-left px-3 py-2 rounded-md hover:bg-elevated focus:bg-elevated focus:outline-none transition-colors"
          :data-testid="`hardcover-search-result-${idx}`"
          @click="onPick(hit)"
        >
          <img
            v-if="hit.normalized.coverUrl"
            :src="hit.normalized.coverUrl"
            :alt="hit.normalized.title ?? 'Cover'"
            class="w-12 h-16 object-cover rounded shrink-0 bg-elevated"
            loading="lazy"
          />
          <div
            v-else
            class="w-12 h-16 rounded bg-elevated shrink-0 flex items-center justify-center"
          >
            <UIcon name="i-lucide-book" class="text-muted" />
          </div>

          <div class="min-w-0 flex-1">
            <div class="font-medium text-highlighted truncate">
              {{ hit.normalized.title ?? "Untitled" }}
            </div>
            <div class="text-sm text-muted truncate">{{ summarize(hit) }}</div>
            <div v-if="hit.normalized.description" class="text-xs text-muted line-clamp-2 mt-1">
              {{ hit.normalized.description }}
            </div>
          </div>
        </button>
      </li>
    </ul>
  </div>
</template>
