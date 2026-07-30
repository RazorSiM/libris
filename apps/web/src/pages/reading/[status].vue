<script setup lang="ts">
import { useLocalStorage } from "@vueuse/core";
import { formatTimeAgo } from "~/utils/formatters";

const VALID_STATUSES = ["reading", "finished", "unread", "paused"] as const;
type ReadingStatus = (typeof VALID_STATUSES)[number];

useDashboard();

const route = useRoute("/reading/[status]");
const router = useRouter();
const status = computed(() => route.params.status);

// Redirect if invalid status — reactive so client-side navigation is also guarded
watch(
  status,
  (s) => {
    if (!VALID_STATUSES.includes(s as ReadingStatus)) {
      router.replace("/reading/reading");
    }
  },
  { immediate: true },
);

const statusLabels: Record<ReadingStatus, string> = {
  reading: "Reading",
  finished: "Finished",
  unread: "Unread",
  paused: "Paused",
};

const statusIcons: Record<ReadingStatus, string> = {
  reading: "i-lucide-book-open",
  finished: "i-lucide-check-circle",
  unread: "i-lucide-book",
  paused: "i-lucide-pause-circle",
};

const statusEmptyMessages: Record<ReadingStatus, string> = {
  reading: "No books currently being read",
  finished: "No finished books yet",
  unread: "No unread books",
  paused: "No paused books",
};

useHead({
  title: computed(() => statusLabels[status.value as ReadingStatus] ?? "Reading"),
});

const search = ref("");
const page = ref(1);
const limit = DEFAULT_PAGE_SIZE;
const sort = useLocalStorage("reading-sort", "last_read_desc");
const viewMode = useLocalStorage<"grid" | "list">("reading-view-mode", "grid");

const sortOptions = [
  { label: "Last read (newest)", value: "last_read_desc" },
  { label: "Last read (oldest)", value: "last_read_asc" },
  { label: "Progress (high)", value: "progress_desc" },
  { label: "Progress (low)", value: "progress_asc" },
  { label: "Title A-Z", value: "title_asc" },
  { label: "Title Z-A", value: "title_desc" },
];

// Map composite sort values to API sort + order params
const sortFieldMap: Record<string, string> = {
  last_read: "lastRead",
  progress: "percentage",
  title: "title",
};

function parseSortParam(value: string): { sort: string; order: string } {
  const lastUnderscore = value.lastIndexOf("_");
  const direction = value.slice(lastUnderscore + 1);
  const field = value.slice(0, lastUnderscore);
  return {
    sort: sortFieldMap[field] ?? "title",
    order: direction === "desc" ? "desc" : "asc",
  };
}

const tabs = VALID_STATUSES.map((s) => ({
  label: statusLabels[s],
  value: s,
  icon: statusIcons[s],
  to: `/reading/${s}`,
}));

const {
  data,
  status: fetchStatus,
  refresh,
} = useReadingQuery({ status, page, search, sort, limit, parseSortParam });

// Reset to page 1 when filters or status change
watch([search, sort, status], () => {
  page.value = 1;
});

const books = computed(() => data.value?.data ?? []);
const totalPages = computed(() => data.value?.pagination?.totalPages ?? 1);

function coverUrl(bookId: string) {
  return `/api/library/${bookId}/cover`;
}

function formatPercentage(value: number | null): string {
  if (value == null) return "0%";
  return `${Math.round(value * 100)}%`;
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="Reading">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>

        <template #right>
          <div class="flex items-center gap-2">
            <USelect
              v-model="sort"
              :items="sortOptions"
              icon="i-lucide-arrow-up-down"
              class="w-48"
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

            <div class="flex items-center gap-0.5" data-testid="view-toggle">
              <UButton
                icon="i-lucide-grid-2x2"
                :variant="viewMode === 'grid' ? 'solid' : 'ghost'"
                :color="viewMode === 'grid' ? 'primary' : 'neutral'"
                size="xs"
                aria-label="Grid view"
                @click="viewMode = 'grid'"
              />
              <UButton
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
      <!-- Status tabs -->
      <div class="border-b border-default">
        <nav class="flex gap-0 px-6" aria-label="Reading status tabs">
          <RouterLink
            v-for="tab in tabs"
            :key="tab.value"
            :to="tab.to"
            :data-testid="`status-tab-${tab.value}`"
            class="flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors"
            :class="
              status === tab.value
                ? 'border-primary text-primary'
                : 'border-transparent text-muted hover:text-highlighted hover:border-accented'
            "
          >
            <UIcon :name="tab.icon" class="size-4" />
            {{ tab.label }}
          </RouterLink>
        </nav>
      </div>

      <ApiError
        v-if="fetchStatus === 'error'"
        message="Could not load reading list"
        @retry="refresh"
      />

      <!-- Grid View -->
      <div v-else-if="viewMode === 'grid'" class="p-6">
        <div
          v-if="fetchStatus !== 'pending' && books.length > 0"
          class="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-5 gap-x-5 gap-y-8 justify-items-center mx-auto max-w-[1200px]"
        >
          <RouterLink
            v-for="book in books"
            :key="book.id"
            :to="`/library/${book.id}`"
            :data-testid="`book-card-${book.id}`"
            class="group flex w-full max-w-56 flex-col gap-2"
          >
            <div
              class="relative aspect-[2/3] rounded-lg overflow-hidden bg-elevated shadow-sm group-hover:shadow-md transition-shadow"
            >
              <img
                v-if="book.coverPath"
                :src="coverUrl(book.id)"
                :alt="book.title || 'Book cover'"
                loading="lazy"
                decoding="async"
                class="w-full h-full object-cover"
              />
              <div v-else class="w-full h-full flex items-center justify-center">
                <UIcon name="i-lucide-book-open" class="text-3xl text-muted" />
              </div>

              <!-- Progress overlay for reading/paused -->
              <div
                v-if="book.percentage != null && book.percentage > 0"
                class="absolute bottom-0 left-0 right-0 bg-black/60 px-2 py-1"
              >
                <div class="flex items-center justify-between text-xs text-white mb-0.5">
                  <span>{{ formatPercentage(book.percentage) }}</span>
                  <span v-if="book.device" class="truncate ml-1">{{ book.device }}</span>
                </div>
                <div
                  :data-testid="`progress-bar-${book.id}`"
                  class="h-1 bg-white/30 rounded-full overflow-hidden"
                >
                  <div
                    class="h-full rounded-full transition-all"
                    :class="status === 'finished' ? 'bg-success-400' : 'bg-info-400'"
                    :style="{ width: formatPercentage(book.percentage) }"
                  />
                </div>
              </div>
            </div>
            <div class="min-w-0">
              <p
                class="text-sm font-medium text-highlighted truncate group-hover:text-primary transition-colors"
              >
                {{ book.title || "Unknown" }}
              </p>
              <p class="text-xs text-muted truncate">{{ book.author || "Unknown Author" }}</p>
              <p v-if="book.lastReadAt" class="text-xs text-dimmed">
                {{ formatTimeAgo(book.lastReadAt) }}
              </p>
            </div>
          </RouterLink>
        </div>

        <!-- Grid skeleton -->
        <div
          v-if="fetchStatus === 'pending'"
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
      <div v-else-if="viewMode === 'list'" class="p-6">
        <div v-if="fetchStatus !== 'pending' && books.length > 0" class="space-y-2">
          <RouterLink
            v-for="book in books"
            :key="book.id"
            :to="`/library/${book.id}`"
            :data-testid="`book-card-${book.id}`"
            class="flex items-center gap-3 p-3 rounded-lg bg-elevated hover:ring-1 hover:ring-accented transition-all"
          >
            <div class="shrink-0 w-10 h-14 rounded overflow-hidden bg-elevated">
              <img
                v-if="book.coverPath"
                :src="coverUrl(book.id)"
                :alt="book.title || 'Book cover'"
                loading="lazy"
                decoding="async"
                class="w-full h-full object-cover"
              />
              <div v-else class="w-full h-full flex items-center justify-center">
                <UIcon name="i-lucide-book-open" class="text-muted" />
              </div>
            </div>
            <div class="flex-1 min-w-0">
              <p class="text-sm font-medium text-highlighted truncate">
                {{ book.title || "Unknown" }}
              </p>
              <p class="text-xs text-muted truncate">{{ book.author || "Unknown Author" }}</p>
            </div>
            <div
              v-if="book.percentage != null && book.percentage > 0"
              class="flex items-center gap-2 shrink-0"
            >
              <div
                :data-testid="`progress-bar-${book.id}`"
                class="w-24 h-1.5 bg-accented rounded-full overflow-hidden"
              >
                <div
                  class="h-full rounded-full transition-all"
                  :class="status === 'finished' ? 'bg-success-400' : 'bg-info-400'"
                  :style="{ width: formatPercentage(book.percentage) }"
                />
              </div>
              <span class="text-xs text-muted w-8 text-right">{{
                formatPercentage(book.percentage)
              }}</span>
            </div>
            <div v-if="book.device" class="hidden sm:block">
              <UBadge variant="subtle" color="neutral" size="xs">
                {{ book.device }}
              </UBadge>
            </div>
            <div v-if="book.lastReadAt" class="text-xs text-dimmed shrink-0">
              {{ formatTimeAgo(book.lastReadAt) }}
            </div>
          </RouterLink>
        </div>

        <!-- List skeleton -->
        <div v-if="fetchStatus === 'pending'" class="space-y-2">
          <div v-for="i in 8" :key="i" class="flex items-center gap-3 p-3">
            <USkeleton class="w-10 h-14 rounded" />
            <div class="flex-1 space-y-2">
              <USkeleton class="h-4 w-3/4" />
              <USkeleton class="h-3 w-1/2" />
            </div>
          </div>
        </div>
      </div>

      <template v-if="fetchStatus !== 'error'">
        <div v-if="totalPages > 1" class="flex justify-center py-4 border-t border-accented">
          <UPagination
            v-model:page="page"
            :total="data?.pagination?.total ?? 0"
            :items-per-page="limit"
          />
        </div>

        <div
          v-if="fetchStatus === 'success' && books.length === 0"
          class="flex flex-col items-center justify-center py-12 gap-2"
        >
          <UIcon
            :name="statusIcons[status as ReadingStatus] ?? 'i-lucide-book'"
            class="text-3xl text-muted"
          />
          <p class="text-muted">
            {{ statusEmptyMessages[status as ReadingStatus] ?? "No books found" }}
          </p>
        </div>
      </template>
    </template>
  </UDashboardPanel>
</template>
