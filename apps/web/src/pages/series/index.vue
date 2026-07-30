<script setup lang="ts">
useDashboard();

useHead({
  title: "Series",
});

const { search, debouncedSearch } = useDebouncedSearch();

const { data, status, refresh } = useSeriesListQuery({ q: debouncedSearch });

const seriesList = computed(() => data.value?.data ?? []);

function seriesCoverFromUrl(item: { coverUrl: string | null; coverBookId: string | null }) {
  // Prefer the Hardcover-matched URL; fall back to the embedded-cover
  // extraction endpoint so series with unmatched books still render a cover.
  if (item.coverUrl) return item.coverUrl;
  if (item.coverBookId) return `/api/library/${item.coverBookId}/cover`;
  return null;
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="Series">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>

        <template #right>
          <div class="flex items-center gap-2">
            <UInput
              v-model="search"
              icon="i-lucide-search"
              placeholder="Search series..."
              class="w-64"
              data-testid="series-search"
            />

            <div class="w-px h-6 bg-accented" />

            <ColorModeToggle />
          </div>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <ApiError v-if="status === 'error'" message="Could not load series" @retry="refresh" />

      <div v-else class="p-6">
        <!-- Grid -->
        <div
          v-if="status !== 'pending' && seriesList.length > 0"
          class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-x-5 gap-y-8 justify-items-center mx-auto max-w-[1200px]"
        >
          <RouterLink
            v-for="item in seriesList"
            :key="item.name"
            :to="`/series/${encodeURIComponent(item.name)}`"
            class="group flex w-full max-w-56 flex-col gap-2"
            data-testid="series-card"
          >
            <div
              class="aspect-[2/3] rounded-lg overflow-hidden bg-elevated shadow-sm group-hover:shadow-md transition-shadow"
            >
              <img
                v-if="seriesCoverFromUrl(item)"
                :src="seriesCoverFromUrl(item)!"
                :alt="item.name"
                loading="lazy"
                decoding="async"
                class="w-full h-full object-cover"
              />
              <div v-else class="w-full h-full flex items-center justify-center">
                <UIcon name="i-lucide-library-big" class="text-3xl text-muted" />
              </div>
            </div>
            <div class="min-w-0">
              <p
                class="text-sm font-medium text-highlighted truncate group-hover:text-primary transition-colors"
              >
                {{ item.name }}
              </p>
              <p class="text-xs text-muted">
                {{ item.bookCount }} {{ item.bookCount === 1 ? "book" : "books" }}
              </p>
            </div>
          </RouterLink>
        </div>

        <!-- Skeleton -->
        <div
          v-if="status === 'pending'"
          class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-x-5 gap-y-8 justify-items-center mx-auto max-w-[1200px]"
        >
          <div v-for="i in 10" :key="i" class="w-full max-w-56 space-y-2">
            <USkeleton class="aspect-[2/3] w-full rounded-lg" />
            <USkeleton class="h-4 w-3/4" />
            <USkeleton class="h-3 w-1/2" />
          </div>
        </div>

        <!-- Empty state -->
        <div
          v-if="status === 'success' && seriesList.length === 0"
          class="flex items-center justify-center py-12"
        >
          <p class="text-muted">No series found</p>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
