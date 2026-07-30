<script setup lang="ts">
import { h, resolveComponent } from "vue";
import type { TableColumn, TableRow } from "@nuxt/ui";
import { useLocalStorage } from "@vueuse/core";
import { languageLabel } from "@libris/api-hono/languages";

const UBadge = resolveComponent("UBadge");

useDashboard();

useHead({
  title: "Library",
});

const router = useRouter();

const { search, debouncedSearch } = useDebouncedSearch();
const page = ref(1);
const limit = DEFAULT_PAGE_SIZE;
const author = ref<string>();
const genre = ref<string>();
const language = ref<string>();
const series = ref<string>();
const uploaderId = ref<string>();
const filtersOpen = ref(false);
const sort = useLocalStorage("library-sort", "title_asc");

const { data: facets } = useLibraryFacetsQuery();

const authorOptions = computed(() => facets.value?.authors ?? []);
const genreOptions = computed(() => facets.value?.genres ?? []);
const languageOptions = computed(() =>
  (facets.value?.languages ?? []).map((code) => ({ label: languageLabel(code), value: code })),
);
const seriesOptions = computed(() => facets.value?.series ?? []);
const uploaderOptions = computed(() =>
  (facets.value?.uploaders ?? []).map((uploader) => ({
    label: uploader.label,
    value: uploader.id,
  })),
);
const viewMode = useLocalStorage<"grid" | "list">("library-view-mode", "grid");

const sortOptions = [
  { label: "Title A-Z", value: "title_asc" },
  { label: "Title Z-A", value: "title_desc" },
  { label: "Author A-Z", value: "author_asc" },
  { label: "Author Z-A", value: "author_desc" },
  { label: "Newest first", value: "added_newest" },
  { label: "Oldest first", value: "added_oldest" },
  { label: "Series order", value: "series_asc" },
];

const { data, status, refresh } = useLibraryListQuery({
  page,
  limit,
  debouncedSearch,
  author,
  genre,
  language,
  series,
  uploaderId,
  sort,
});

// Reset to page 1 when filters change
watch([debouncedSearch, author, genre, language, series, uploaderId, sort], () => {
  page.value = 1;
});

interface LibraryRow {
  id: string;
  title: string;
  author: string;
  language: string | null;
  uploaderLabel: string | null;
  series: string | null;
  seriesIndex: number | null;
  format: string;
  genres: string[];
  coverUrl: string | null;
  createdAt: string;
}

const columns: TableColumn<LibraryRow>[] = [
  {
    accessorKey: "title",
    header: "Title",
  },
  {
    accessorKey: "author",
    header: "Author",
  },
  {
    accessorKey: "language",
    header: "Language",
    cell: ({ row }) => {
      const value = row.original.language;
      if (!value) return h("span", { class: "text-muted" }, "—");
      return h("span", { class: "text-xs text-muted font-medium" }, languageLabel(value));
    },
  },
  {
    accessorKey: "series",
    header: "Series",
    cell: ({ row }) => {
      const s = row.original.series;
      if (!s) return h("span", { class: "text-muted" }, "—");
      const idx = row.original.seriesIndex;
      const label = idx != null ? `${s} #${idx}` : s;
      return h("span", { class: "text-sm truncate max-w-[160px] block" }, label);
    },
  },
  {
    accessorKey: "format",
    header: "Format",
    cell: ({ row }) => {
      return h(
        "span",
        { class: "uppercase text-xs font-medium text-muted" },
        row.getValue("format"),
      );
    },
  },
  {
    accessorKey: "genres",
    header: "Genres",
    cell: ({ row }) => {
      const genres = row.getValue("genres") as string[];
      if (!genres?.length) return h("span", { class: "text-muted" }, "—");
      return h(
        "div",
        { class: "flex gap-1 flex-wrap" },
        genres
          .slice(0, 2)
          .map((g) => h(UBadge, { variant: "subtle", color: "neutral", size: "xs" }, () => g)),
      );
    },
  },
  {
    accessorKey: "uploaderLabel",
    header: "Uploaded by",
    cell: ({ row }) => {
      const value = row.original.uploaderLabel;
      if (!value) return h("span", { class: "text-muted" }, "—");
      return h("span", { class: "text-sm truncate max-w-[160px] block" }, value);
    },
  },
  {
    accessorKey: "createdAt",
    header: "Added",
    cell: ({ row }) => {
      return new Date(row.getValue("createdAt")).toLocaleDateString("en-US", {
        day: "numeric",
        month: "short",
        year: "numeric",
      });
    },
  },
];

const rows = computed<LibraryRow[]>(() => {
  return (data.value?.data ?? []).map((book) => ({
    id: book.id,
    title: book.title || "Unknown",
    author: book.author || "Unknown Author",
    language: book.language ?? null,
    uploaderLabel: book.uploader?.label ?? null,
    series: book.series ?? null,
    seriesIndex: book.seriesIndex ?? null,
    format: book.files[0]?.format ?? "—",
    genres: book.genres,
    coverUrl: book.coverPath ? `/api/library/${book.id}/cover` : null,
    createdAt: book.createdAt,
  }));
});

const totalBooks = computed(() => data.value?.pagination?.total ?? 0);
const totalPages = computed(() => data.value?.pagination?.totalPages ?? 1);

const activeFilters = computed(() => {
  const uploaderLabel = uploaderOptions.value.find(
    (option) => option.value === uploaderId.value,
  )?.label;
  return [
    author.value ? { key: "author", label: `Author: ${author.value}` } : null,
    genre.value ? { key: "genre", label: `Genre: ${genre.value}` } : null,
    language.value
      ? { key: "language", label: `Language: ${languageLabel(language.value)}` }
      : null,
    series.value ? { key: "series", label: `Series: ${series.value}` } : null,
    uploaderId.value && uploaderLabel
      ? { key: "uploaderId", label: `Uploaded by: ${uploaderLabel}` }
      : null,
  ].filter(Boolean) as { key: string; label: string }[];
});

const hasActiveFilters = computed(() => activeFilters.value.length > 0);
const activeFilterCount = computed(() => activeFilters.value.length);

function clearFilters() {
  author.value = undefined;
  genre.value = undefined;
  language.value = undefined;
  series.value = undefined;
  uploaderId.value = undefined;
}

function removeFilter(key: string) {
  if (key === "author") author.value = undefined;
  if (key === "genre") genre.value = undefined;
  if (key === "language") language.value = undefined;
  if (key === "series") series.value = undefined;
  if (key === "uploaderId") uploaderId.value = undefined;
}

function onSelect(_e: Event, row: TableRow<LibraryRow>) {
  router.push(`/library/${row.original.id}`);
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="Library">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>

        <template #right>
          <div class="flex items-center gap-2">
            <USelect
              v-model="sort"
              :items="sortOptions"
              icon="i-lucide-arrow-up-down"
              class="w-44"
              data-testid="sort-select"
            />

            <div class="w-px h-6 bg-accented" />

            <UInput
              v-model="search"
              icon="i-lucide-search"
              placeholder="Search books..."
              class="w-64"
              data-testid="search-input"
            />

            <div class="w-px h-6 bg-accented" />

            <UPopover
              :open="filtersOpen"
              :content="{ side: 'bottom', align: 'end', sideOffset: 8 }"
              @update:open="filtersOpen = $event"
            >
              <UButton
                data-testid="open-filters-btn"
                icon="i-lucide-sliders-horizontal"
                variant="outline"
                color="neutral"
                size="sm"
              >
                Filters
                <UBadge
                  v-if="activeFilterCount > 0"
                  variant="soft"
                  color="primary"
                  size="xs"
                  class="ml-1"
                >
                  {{ activeFilterCount }}
                </UBadge>
              </UButton>
              <template #content>
                <div class="w-80 p-4 space-y-4" data-testid="library-filters-panel">
                  <USelectMenu
                    v-model="author"
                    :items="authorOptions"
                    placeholder="All authors"
                    icon="i-lucide-user"
                    searchable
                    data-testid="author-filter"
                  />
                  <USelectMenu
                    v-model="genre"
                    :items="genreOptions"
                    placeholder="All genres"
                    icon="i-lucide-tag"
                    searchable
                    data-testid="genre-filter"
                  />
                  <USelectMenu
                    v-model="language"
                    :items="languageOptions"
                    value-key="value"
                    placeholder="All languages"
                    icon="i-lucide-languages"
                    searchable
                    data-testid="language-filter"
                  />
                  <USelectMenu
                    v-model="series"
                    :items="seriesOptions"
                    placeholder="All series"
                    icon="i-lucide-library-big"
                    searchable
                    data-testid="series-filter"
                  />
                  <USelectMenu
                    v-model="uploaderId"
                    value-key="value"
                    :items="uploaderOptions"
                    placeholder="All uploaders"
                    icon="i-lucide-upload"
                    searchable
                    data-testid="uploader-filter"
                  />
                  <div class="flex justify-between gap-2 pt-2">
                    <UButton variant="ghost" color="neutral" @click="clearFilters">
                      Clear filters
                    </UButton>
                    <UButton color="primary" @click="filtersOpen = false">Done</UButton>
                  </div>
                </div>
              </template>
            </UPopover>

            <div class="w-px h-6 bg-accented" />

            <div class="flex items-center gap-0.5">
              <UButton
                data-testid="grid-view-btn"
                icon="i-lucide-grid-2x2"
                :variant="viewMode === 'grid' ? 'solid' : 'ghost'"
                :color="viewMode === 'grid' ? 'primary' : 'neutral'"
                size="xs"
                aria-label="Grid view"
                @click="viewMode = 'grid'"
              />
              <UButton
                data-testid="list-view-btn"
                icon="i-lucide-list"
                :variant="viewMode === 'list' ? 'solid' : 'ghost'"
                :color="viewMode === 'list' ? 'primary' : 'neutral'"
                size="xs"
                aria-label="List view"
                @click="viewMode = 'list'"
              />
            </div>

            <div class="w-px h-6 bg-accented" />

            <ColorModeToggle />
          </div>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <ApiError v-if="status === 'error'" message="Could not load library" @retry="refresh" />

      <div v-if="status !== 'error'" class="px-6 pt-4 flex flex-wrap items-center gap-2">
        <p data-testid="library-results-count" class="text-sm text-dimmed mr-2">
          {{ totalBooks }} {{ totalBooks === 1 ? "book" : "books" }}
        </p>
        <UButton
          v-for="filter in activeFilters"
          :key="filter.key"
          :label="filter.label"
          icon="i-lucide-x"
          variant="outline"
          color="neutral"
          size="xs"
          :data-testid="`active-filter-${filter.key}`"
          @click="removeFilter(filter.key)"
        />
        <UButton
          v-if="hasActiveFilters"
          data-testid="clear-filters-btn"
          icon="i-lucide-rotate-ccw"
          variant="ghost"
          color="neutral"
          size="xs"
          @click="clearFilters"
        >
          Clear all
        </UButton>
      </div>

      <!-- Grid View -->
      <div v-if="status !== 'error' && viewMode === 'grid'" class="p-6">
        <div
          v-if="status !== 'pending' && rows.length > 0"
          class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-x-5 gap-y-8 justify-items-center mx-auto max-w-[1200px]"
        >
          <RouterLink
            v-for="book in rows"
            :key="book.id"
            :to="`/library/${book.id}`"
            :data-testid="`book-card-${book.id}`"
            class="group flex w-full max-w-56 flex-col gap-2"
          >
            <div
              class="aspect-[2/3] rounded-lg overflow-hidden bg-elevated shadow-sm group-hover:shadow-md transition-shadow"
            >
              <!-- Native img stays here because cover endpoints are auth-protected API routes. -->
              <img
                v-if="book.coverUrl"
                :src="book.coverUrl"
                :alt="book.title"
                loading="lazy"
                decoding="async"
                class="w-full h-full object-cover"
              />
              <div v-else class="w-full h-full flex items-center justify-center">
                <UIcon name="i-lucide-book-open" class="text-3xl text-muted" />
              </div>
            </div>
            <div class="min-w-0">
              <p
                class="text-sm font-medium text-highlighted truncate group-hover:text-primary transition-colors"
              >
                {{ book.title }}
              </p>
              <p class="text-xs text-muted truncate">{{ book.author }}</p>
              <div class="flex flex-wrap gap-1 mt-1">
                <UBadge v-if="book.language" variant="subtle" color="neutral" size="xs">
                  {{ languageLabel(book.language) }}
                </UBadge>
                <UBadge v-if="book.uploaderLabel" variant="subtle" color="info" size="xs">
                  {{ book.uploaderLabel }}
                </UBadge>
              </div>
              <p v-if="book.series" class="text-xs text-muted truncate" data-testid="book-series">
                {{ book.seriesIndex != null ? `${book.series} #${book.seriesIndex}` : book.series }}
              </p>
            </div>
          </RouterLink>
        </div>

        <!-- Grid skeleton -->
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
      </div>

      <!-- List View -->
      <UTable
        v-else-if="status !== 'error' && viewMode === 'list'"
        :data="rows"
        :columns="columns"
        :loading="status === 'pending'"
        class="w-full"
        @select="onSelect"
      />

      <template v-if="status !== 'error'">
        <div
          v-if="totalPages > 1"
          data-testid="pagination"
          class="mt-8 flex justify-center border-t border-accented pt-6 pb-4"
        >
          <UPagination
            v-model:page="page"
            :total="data?.pagination?.total ?? 0"
            :items-per-page="limit"
          />
        </div>

        <div
          v-if="status === 'success' && rows.length === 0"
          class="flex items-center justify-center py-12"
        >
          <p data-testid="empty-library" class="text-muted">No books in library</p>
        </div>
      </template>
    </template>
  </UDashboardPanel>
</template>
