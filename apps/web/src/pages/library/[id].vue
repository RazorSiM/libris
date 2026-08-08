<script lang="ts">
import { defineColadaLoader } from "vue-router/experimental/pinia-colada";
import { useApiClient } from "~/composables/useApiClient";

export const useBookDetailLoader = defineColadaLoader("/library/[id]", {
  key: (to) => ["library", to.params.id],
  query: async (to, { signal }) => {
    const client = useApiClient();
    const res = await client.api.library[":id"].$get(
      { param: { id: to.params.id } },
      { init: { signal } },
    );
    if (!res.ok) throw new Error("Not found");
    return res.json();
  },
  staleTime: 30_000,
});
</script>

<script setup lang="ts">
import { formatFileSize, formatDate, formatTimeAgo } from "~/utils/formatters";
import { useQueryCache } from "@pinia/colada";
import { inboxKeys } from "~/composables/queries/inboxKeys";

interface ProgressEntry {
  document: string;
  device: string;
  deviceId?: string;
  progress: string;
  percentage: number;
  timestamp: number;
}

useDashboard();
useHead({ title: "Book Details" });

const router = useRouter();

defineShortcuts({
  escape: () => router.push("/library"),
});

const route = useRoute("/library/[id]");
const toast = useToast();
const { isAdmin, userId: currentUserId } = useAuth();
const queryCache = useQueryCache();

const canEditBook = computed(
  () => isAdmin.value || (book.value?.createdBy && book.value.createdBy === currentUserId.value),
);

const id = computed(() => route.params.id);

const { data: book, status, refresh } = useBookDetailLoader();

const {
  data: progressData,
  status: progressStatus,
  refresh: refreshProgress,
} = useBookProgressQuery(id);

const coverSrc = computed(() => {
  if (!book.value) return null;
  return book.value.coverPath ? `/api/library/${id.value}/cover` : null;
});

const showDeleteConfirm = ref(false);
const showEditModal = ref(false);
const showRefetchModal = ref(false);
const showStatusModal = ref(false);
const descriptionExpanded = ref(false);

const { mutateAsync: reorganize, isLoading: reorganizing } = useReorganizeBook();
const { mutateAsync: deleteBook } = useDeleteBook();

const actionItems = [
  [
    {
      label: "Edit metadata",
      icon: "i-lucide-pencil",
      onSelect: () => {
        showEditModal.value = true;
      },
    },
    {
      label: "Edit reading status",
      icon: "i-lucide-book-marked",
      onSelect: () => {
        showStatusModal.value = true;
      },
    },
    {
      label: "Refetch metadata",
      icon: "i-lucide-globe",
      onSelect: () => {
        showRefetchModal.value = true;
      },
    },
    {
      label: "Re-organize",
      icon: "i-lucide-folder-sync",
      onSelect: () => handleReorganize(),
    },
  ],
  [
    {
      label: "Delete",
      icon: "i-lucide-trash-2",
      color: "error" as const,
      onSelect: () => {
        showDeleteConfirm.value = true;
      },
    },
  ],
];

async function handleReorganize() {
  try {
    await reorganize(id.value);
    toast.add({ title: "Re-organize job enqueued", color: "success" });
  } catch (err) {
    toast.add({
      title: err instanceof Error ? err.message : "Failed to re-organize",
      color: "error",
    });
  } finally {
    queryCache.invalidateQueries({ key: ["library"] });
    queryCache.invalidateQueries({ key: ["book", id.value] });
    queryCache.invalidateQueries({ key: inboxKeys.list() });
    queryCache.invalidateQueries({ key: inboxKeys.count() });
    queryCache.invalidateQueries({ key: ["series"] });
  }
}

async function handleEditSaved() {
  await refresh();
  queryCache.invalidateQueries({ key: ["library"] });
  queryCache.invalidateQueries({ key: ["book", id.value] });
  queryCache.invalidateQueries({ key: ["series"] });
}

async function handleStatusSaved() {
  await refresh();
  queryCache.invalidateQueries({ key: ["library"] });
  queryCache.invalidateQueries({ key: ["book", id.value] });
  queryCache.invalidateQueries({ key: ["reading-status"] });
}

async function handleRefetchApplied() {
  await refresh();
  queryCache.invalidateQueries({ key: ["library"] });
  queryCache.invalidateQueries({ key: ["book", id.value] });
  queryCache.invalidateQueries({ key: inboxKeys.list() });
  queryCache.invalidateQueries({ key: inboxKeys.count() });
  queryCache.invalidateQueries({ key: ["series"] });
  toast.add({ title: "Metadata updated and re-organize enqueued", color: "success" });
}

async function handleDelete() {
  try {
    await deleteBook(id.value);
    toast.add({ title: "Book deleted", color: "success" });
    router.push("/library");
  } catch (err) {
    toast.add({
      title: err instanceof Error ? err.message : "Failed to delete book",
      color: "error",
    });
  }
}

// Provide library.downloadUrl for template binding (binary endpoint, use URL directly)
const library = {
  downloadUrl: (bookId: string, fileId: string) => `/api/library/${bookId}/download/${fileId}`,
};

function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

const PAUSED_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

function readingStatus(entry: ProgressEntry): {
  label: string;
  color: "success" | "info" | "warning" | "neutral";
} {
  if (entry.percentage >= 0.95) return { label: "Finished", color: "success" };
  const age = Date.now() - entry.timestamp * 1000;
  if (entry.percentage > 0 && age < PAUSED_THRESHOLD_MS) return { label: "Reading", color: "info" };
  if (entry.percentage > 0) return { label: "Paused", color: "warning" };
  return { label: "Unread", color: "neutral" };
}

const AGGREGATE_STATUS_LABEL: Record<
  string,
  { label: string; color: "success" | "info" | "warning" | "neutral" }
> = {
  finished: { label: "Finished", color: "success" },
  reading: { label: "Reading", color: "info" },
  paused: { label: "Paused", color: "warning" },
  unread: { label: "Unread", color: "neutral" },
};

function aggregateStatusBadge(status: string | null | undefined) {
  if (!status) return null;
  return AGGREGATE_STATUS_LABEL[status] ?? null;
}

function aggregateStatusDate(progress: {
  status?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  pausedAt?: string | null;
}): { label: string; date: string } | null {
  if (progress.status === "finished" && progress.finishedAt) {
    return { label: "Finished", date: progress.finishedAt };
  }
  if (progress.status === "paused" && progress.pausedAt) {
    return { label: "Paused", date: progress.pausedAt };
  }
  if (progress.status === "reading" && progress.startedAt) {
    return { label: "Started", date: progress.startedAt };
  }
  return null;
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
              { label: 'Library', icon: 'i-lucide-library', to: '/library' },
              { label: book?.title || 'Book Details' },
            ]"
          />
        </template>

        <template #right>
          <div class="flex items-center gap-2">
            <UDropdownMenu v-if="canEditBook" :items="actionItems">
              <UButton
                icon="i-lucide-ellipsis-vertical"
                variant="ghost"
                color="neutral"
                size="sm"
                data-testid="book-actions-btn"
                :loading="reorganizing"
              />
            </UDropdownMenu>
            <ColorModeToggle />
          </div>
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- Loading skeleton -->
      <div v-if="status === 'pending'" class="max-w-4xl mx-auto p-6 space-y-6">
        <div class="flex gap-6">
          <USkeleton class="w-40 h-60 shrink-0 rounded-lg" />
          <div class="flex-1 space-y-3">
            <USkeleton class="h-7 w-3/4" />
            <USkeleton class="h-5 w-1/3" />
            <div class="flex gap-1.5 mt-3">
              <USkeleton class="h-6 w-16 rounded-full" />
              <USkeleton class="h-6 w-20 rounded-full" />
              <USkeleton class="h-6 w-14 rounded-full" />
            </div>
            <USkeleton class="h-4 w-full mt-4" />
            <USkeleton class="h-4 w-5/6" />
            <USkeleton class="h-4 w-2/3" />
          </div>
        </div>
        <div class="border-t border-default" />
        <div>
          <USkeleton class="h-6 w-20 mb-4" />
          <div class="grid grid-cols-2 gap-x-8 gap-y-3">
            <div v-for="i in 6" :key="i" class="space-y-1">
              <USkeleton class="h-3 w-16" />
              <USkeleton class="h-4 w-24" />
            </div>
          </div>
        </div>
        <div class="border-t border-default" />
        <div>
          <USkeleton class="h-6 w-14 mb-4" />
          <div class="space-y-2">
            <USkeleton class="h-14 w-full rounded-lg" />
          </div>
        </div>
      </div>

      <ApiError
        v-else-if="status === 'error'"
        message="Could not load book details"
        @retry="refresh"
      />

      <div v-else-if="!book" class="flex items-center justify-center py-12">
        <p class="text-muted">Book not found</p>
      </div>

      <div v-else class="max-w-4xl mx-auto p-6 space-y-6">
        <!-- Book header -->
        <div class="flex gap-6">
          <!-- Cover image -->
          <div class="shrink-0">
            <img
              v-if="coverSrc"
              data-testid="book-cover-img"
              :src="coverSrc"
              :alt="book.title || 'Book cover'"
              class="w-40 h-60 rounded-lg shadow-md object-cover"
            />
            <div
              v-else
              data-testid="cover-placeholder"
              class="w-40 h-60 rounded-lg bg-elevated flex items-center justify-center"
            >
              <UIcon name="i-lucide-book-open" class="text-4xl text-muted" />
            </div>
          </div>

          <!-- Title and author -->
          <div class="flex-1 min-w-0">
            <h1 class="text-2xl font-semibold text-highlighted">
              {{ book.title || "Unknown Title" }}
            </h1>
            <p v-if="book.author" class="text-lg text-muted mt-1">{{ book.author }}</p>

            <p v-if="book.series" class="text-sm text-muted mt-2">
              <RouterLink
                :to="`/series/${encodeURIComponent(book.series)}`"
                class="text-primary hover:underline"
                data-testid="series-link"
              >
                {{ book.series }}
              </RouterLink>
              <span v-if="book.seriesIndex != null"> #{{ book.seriesIndex }}</span>
            </p>

            <div v-if="book.genres?.length" class="flex flex-wrap gap-1.5 mt-3">
              <UBadge v-for="g in book.genres" :key="g" variant="subtle" color="neutral">
                {{ g }}
              </UBadge>
            </div>

            <div v-if="book.tags?.length" class="flex flex-wrap gap-1.5 mt-2">
              <UBadge v-for="t in book.tags" :key="t" variant="subtle" color="info" size="xs">
                {{ t }}
              </UBadge>
            </div>

            <p
              v-if="book.uploader?.label"
              class="text-sm text-dimmed mt-3"
              data-testid="book-uploader"
            >
              Uploaded by <span class="text-highlighted">{{ book.uploader.label }}</span>
            </p>

            <div v-if="book.description" class="mt-4">
              <p class="text-sm text-dimmed" :class="{ 'line-clamp-4': !descriptionExpanded }">
                {{ book.description }}
              </p>
              <button
                data-testid="show-more-btn"
                class="text-sm text-primary mt-1 hover:underline cursor-pointer"
                :aria-expanded="descriptionExpanded"
                @click="descriptionExpanded = !descriptionExpanded"
              >
                {{ descriptionExpanded ? "Show less" : "Show more" }}
              </button>
            </div>
          </div>
        </div>

        <div class="border-t border-default" />

        <!-- Metadata details -->
        <div>
          <h2 class="text-lg font-medium text-highlighted mb-4">Details</h2>
          <dl class="grid grid-cols-2 gap-x-8 gap-y-3 text-sm">
            <div v-if="book.publisher">
              <dt class="text-muted">Publisher</dt>
              <dd class="text-highlighted">{{ book.publisher }}</dd>
            </div>
            <div v-if="book.publishedYear">
              <dt class="text-muted">Published</dt>
              <dd class="text-highlighted">{{ book.publishedYear }}</dd>
            </div>
            <div v-if="book.language">
              <dt class="text-muted">Language</dt>
              <dd class="text-highlighted uppercase">{{ book.language }}</dd>
            </div>
            <div v-if="book.pageCount">
              <dt class="text-muted">Pages</dt>
              <dd class="text-highlighted">{{ book.pageCount }}</dd>
            </div>
            <div v-if="book.isbn13">
              <dt class="text-muted">ISBN-13</dt>
              <dd class="text-highlighted font-mono text-xs">{{ book.isbn13 }}</dd>
            </div>
            <div v-if="book.isbn10">
              <dt class="text-muted">ISBN-10</dt>
              <dd class="text-highlighted font-mono text-xs">{{ book.isbn10 }}</dd>
            </div>
            <div v-if="book.approvedAt">
              <dt class="text-muted">Organized</dt>
              <dd class="text-highlighted">{{ formatDate(book.approvedAt) }}</dd>
            </div>
            <div>
              <dt class="text-muted">Added</dt>
              <dd class="text-highlighted">{{ formatDate(book.createdAt) }}</dd>
            </div>
          </dl>
        </div>

        <div class="border-t border-default" />

        <!-- Reading Progress -->
        <div data-testid="reading-progress-section">
          <h2 class="text-sm font-medium text-muted uppercase tracking-wider mb-3">
            Reading Progress
          </h2>

          <ErrorBoundary>
            <ApiError
              v-if="progressStatus === 'error'"
              data-testid="reading-progress-error"
              message="Failed to load reading progress"
              retry-label="Retry"
              @retry="refreshProgress"
            />

            <div
              v-else-if="progressStatus === 'pending'"
              data-testid="reading-progress-loading"
              class="space-y-2"
            >
              <USkeleton class="h-14 w-full rounded-lg" />
            </div>

            <!--
              No per-device kosync entries: surface the aggregate status
              instead of the literal "Not started yet". The status may come
              from a manual override or from Hardcover (external_status), and
              we want the user to see it here even though they have no
              reading-progress rows yet.
            -->
            <div
              v-else-if="
                !progressData?.progress?.length &&
                book?.progress?.status &&
                book.progress.status !== 'unread'
              "
              data-testid="reading-progress-aggregate"
              class="p-3 rounded-lg bg-elevated space-y-2"
            >
              <div class="flex items-center justify-between">
                <UBadge
                  v-if="aggregateStatusBadge(book.progress.status)"
                  data-testid="reading-progress-aggregate-badge"
                  variant="subtle"
                  :color="aggregateStatusBadge(book.progress.status)!.color"
                  size="xs"
                >
                  {{ aggregateStatusBadge(book.progress.status)!.label }}
                </UBadge>
                <span
                  v-if="aggregateStatusDate(book.progress)"
                  data-testid="reading-progress-aggregate-date"
                  class="text-xs text-muted"
                >
                  {{ aggregateStatusDate(book.progress)!.label }}
                  {{ formatDate(aggregateStatusDate(book.progress)!.date) }}
                </span>
              </div>
              <p
                v-if="book.progress.manuallySet || book.progress.externallySet"
                data-testid="reading-progress-aggregate-source"
                class="text-xs text-dimmed"
              >
                {{ book.progress.manuallySet ? "Marked manually" : "Synced from Hardcover" }}
              </p>
            </div>

            <p
              v-else-if="!progressData?.progress?.length"
              data-testid="reading-progress-empty"
              class="text-sm text-dimmed"
            >
              Not started yet
            </p>

            <div v-else class="space-y-3">
              <div
                v-for="entry in progressData.progress"
                :key="entry.device"
                :data-testid="`reading-progress-device-${entry.device}`"
                class="p-3 rounded-lg bg-elevated space-y-2"
              >
                <div class="flex items-center justify-between">
                  <span class="text-sm font-medium text-highlighted">{{ entry.device }}</span>
                  <UBadge
                    data-testid="reading-progress-status-badge"
                    variant="subtle"
                    :color="readingStatus(entry).color"
                    size="xs"
                  >
                    {{ readingStatus(entry).label }}
                  </UBadge>
                </div>
                <UProgress
                  :data-testid="`reading-progress-bar-${entry.device}`"
                  :model-value="entry.percentage * 100"
                  size="sm"
                  :ui="{ indicator: 'transition-none animate-shimmer' }"
                />
                <div class="flex justify-between text-xs text-dimmed">
                  <span :data-testid="`reading-progress-percentage-${entry.device}`">
                    {{ formatPercentage(entry.percentage) }}
                  </span>
                  <span>{{ formatTimeAgo(entry.timestamp) }}</span>
                </div>
              </div>
            </div>

            <template #error="{ error, clearError }">
              <div data-testid="reading-progress-boundary-error" class="py-4">
                <ApiError
                  message="Something went wrong displaying reading progress"
                  @retry="clearError"
                />
              </div>
            </template>
          </ErrorBoundary>
        </div>

        <div class="border-t border-default" />

        <!-- Files / Downloads -->
        <div>
          <h2 class="text-lg font-medium text-highlighted mb-4">Files</h2>
          <div class="space-y-2">
            <div
              v-for="file in book.files"
              :key="file.id"
              class="flex items-center gap-3 p-3 rounded-lg bg-elevated"
            >
              <UIcon name="i-lucide-file" class="text-muted shrink-0" />
              <div class="flex-1 min-w-0">
                <p class="text-sm text-highlighted truncate">{{ file.originalName }}</p>
                <div class="flex items-center gap-2 mt-0.5">
                  <UBadge variant="subtle" color="neutral" size="xs" class="uppercase">
                    {{ file.format }}
                  </UBadge>
                  <span class="text-xs text-dimmed">{{ formatFileSize(file.fileSize) }}</span>
                </div>
              </div>
              <UButton
                data-testid="download-btn"
                :href="library.downloadUrl(id, file.id)"
                icon="i-lucide-download"
                label="Download"
                variant="outline"
                color="primary"
                size="sm"
                target="_blank"
                external
              />
            </div>
          </div>

          <div v-if="!book.files?.length" class="text-sm text-muted py-4">No files available</div>
        </div>
      </div>
    </template>
  </UDashboardPanel>

  <EditBookModal
    v-if="book"
    :open="showEditModal"
    :book="book"
    @update:open="showEditModal = $event"
    @saved="handleEditSaved"
  />

  <RefetchMetadataModal
    v-if="book"
    :open="showRefetchModal"
    :book="book"
    @update:open="showRefetchModal = $event"
    @applied="handleRefetchApplied"
  />

  <EditReadingStatusModal
    v-if="book"
    :open="showStatusModal"
    :book-id="id"
    :progress="book.progress ?? null"
    @update:open="showStatusModal = $event"
    @saved="handleStatusSaved"
  />

  <ConfirmDialog
    :open="showDeleteConfirm"
    title="Delete Book"
    message="This will permanently remove the book and its files. This action cannot be undone."
    confirm-label="Delete"
    @update:open="showDeleteConfirm = $event"
    @confirm="handleDelete"
  />
</template>
import { inboxKeys } from "~/composables/queries/inboxKeys";
