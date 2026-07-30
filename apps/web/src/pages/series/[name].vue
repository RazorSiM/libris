<script lang="ts">
import { defineColadaLoader } from "vue-router/experimental/pinia-colada";
import { useApiClient } from "~/composables/useApiClient";

export const useSeriesDetailLoader = defineColadaLoader("/series/[name]", {
  key: (to) => ["series", decodeURIComponent(to.params.name)],
  query: async (to, { signal }) => {
    const client = useApiClient();
    const name = decodeURIComponent(to.params.name);
    const res = await client.api.series[":name"].$get({ param: { name } }, { init: { signal } });
    if (!res.ok) throw new Error("Not found");
    return res.json();
  },
  staleTime: 30_000,
});
</script>

<script setup lang="ts">
useDashboard();

const route = useRoute("/series/[name]");
const router = useRouter();

const seriesName = computed(() => decodeURIComponent(route.params.name));

useHead({ title: () => seriesName.value });

defineShortcuts({
  escape: () => router.push("/series"),
});

const { data, status, refresh } = useSeriesDetailLoader();

const books = computed(() => data.value?.books ?? []);

function bookCoverUrl(book: { id: string; coverPath: string | null }) {
  if (!book.coverPath) return null;
  return `/api/library/${book.id}/cover`;
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar>
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>

        <template #title>
          <UBreadcrumb
            :items="[
              { label: 'Series', icon: 'i-lucide-library-big', to: '/series' },
              { label: seriesName },
            ]"
          />
        </template>

        <template #right>
          <ColorModeToggle />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- Loading skeleton -->
      <div v-if="status === 'pending'" class="max-w-4xl mx-auto p-6 space-y-6">
        <div class="space-y-2">
          <USkeleton class="h-8 w-1/3" />
          <USkeleton class="h-5 w-24" />
        </div>
        <div class="space-y-3">
          <div v-for="i in 4" :key="i" class="flex gap-4 items-center">
            <USkeleton class="w-12 h-18 shrink-0 rounded" />
            <div class="flex-1 space-y-2">
              <USkeleton class="h-5 w-1/2" />
              <USkeleton class="h-4 w-1/3" />
            </div>
          </div>
        </div>
      </div>

      <ApiError
        v-else-if="status === 'error'"
        message="Could not load series details"
        @retry="refresh"
      />

      <div v-else class="max-w-4xl mx-auto p-6 space-y-6">
        <!-- Header -->
        <div data-testid="series-header">
          <h1 class="text-2xl font-semibold text-highlighted">{{ seriesName }}</h1>
          <p class="text-sm text-muted mt-1">
            {{ data?.total ?? 0 }} {{ (data?.total ?? 0) === 1 ? "book" : "books" }}
          </p>
        </div>

        <!-- Books list -->
        <div class="space-y-3">
          <RouterLink
            v-for="book in books"
            :key="book.id"
            :to="`/library/${book.id}`"
            class="flex gap-4 items-center p-3 rounded-lg hover:bg-elevated transition-colors group"
            data-testid="series-book-row"
          >
            <!-- Position number -->
            <div class="w-8 shrink-0 text-center" data-testid="series-book-position">
              <span
                v-if="book.seriesIndex != null"
                class="text-lg font-semibold text-muted group-hover:text-primary transition-colors"
              >
                {{ book.seriesIndex }}
              </span>
              <span v-else class="text-sm text-dimmed">--</span>
            </div>

            <!-- Cover -->
            <div class="w-12 h-18 shrink-0 rounded overflow-hidden bg-elevated shadow-sm">
              <img
                v-if="bookCoverUrl(book)"
                :src="bookCoverUrl(book)!"
                :alt="book.title || 'Book cover'"
                loading="lazy"
                decoding="async"
                class="w-full h-full object-cover"
              />
              <div v-else class="w-full h-full flex items-center justify-center">
                <UIcon name="i-lucide-book-open" class="text-lg text-muted" />
              </div>
            </div>

            <!-- Info -->
            <div class="flex-1 min-w-0">
              <p
                class="text-sm font-medium text-highlighted truncate group-hover:text-primary transition-colors"
              >
                {{ book.title || "Unknown Title" }}
              </p>
              <p class="text-xs text-muted truncate">{{ book.author || "Unknown Author" }}</p>
            </div>

            <!-- Genres -->
            <div v-if="book.genres?.length" class="hidden md:flex gap-1 shrink-0">
              <UBadge
                v-for="g in book.genres.slice(0, 2)"
                :key="g"
                variant="subtle"
                color="neutral"
                size="xs"
              >
                {{ g }}
              </UBadge>
            </div>
          </RouterLink>
        </div>

        <!-- Empty state -->
        <div v-if="books.length === 0 && status === 'success'" class="text-center py-12">
          <p class="text-muted">No books in this series</p>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
