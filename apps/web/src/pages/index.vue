<script setup lang="ts">
import { formatFileSize, formatTimeAgo } from "~/utils/formatters";

useDashboard();

useHead({
  title: "Home",
});

const { data, status, refresh } = useDashboardQuery();

const QUEUE_LABELS: Record<string, string> = {
  "book-detected": "Detection",
  "book-parse-file": "Parsing",
  "book-fetch-metadata": "Metadata",
  "book-organize": "Organize",
};

function queueLabel(name: string): string {
  return QUEUE_LABELS[name] ?? name;
}

const pipelineTotals = computed(() => {
  const totals = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
  if (!data.value?.pipeline) return totals;
  for (const q of Object.values(data.value.pipeline)) {
    totals.waiting += q.waiting;
    totals.active += q.active;
    totals.completed += q.completed;
    totals.failed += q.failed;
    totals.delayed += q.delayed;
  }
  return totals;
});

const pipelineHasActivity = computed(() => {
  const t = pipelineTotals.value;
  return t.active > 0 || t.waiting > 0 || t.failed > 0 || t.delayed > 0;
});

const activeOrFailedQueues = computed(() => {
  if (!data.value?.pipeline) return [];
  return Object.entries(data.value.pipeline).filter(([, q]) => q.active > 0 || q.failed > 0);
});
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="Home">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <ColorModeToggle />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- Loading skeletons -->
      <div v-if="status === 'pending'" class="p-6 space-y-8">
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div
            v-for="i in 4"
            :key="i"
            class="rounded-lg border border-default bg-default p-4 space-y-2"
          >
            <div class="flex items-center gap-2">
              <USkeleton class="h-5 w-5 rounded" />
              <USkeleton class="h-4 w-24" />
            </div>
            <USkeleton class="h-8 w-16" />
          </div>
        </div>
        <div>
          <USkeleton class="h-6 w-40 mb-4" />
          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <div
              v-for="i in 3"
              :key="i"
              class="flex gap-4 rounded-lg border border-default bg-default p-4"
            >
              <USkeleton class="w-16 h-24 shrink-0 rounded" />
              <div class="flex-1 space-y-2">
                <USkeleton class="h-5 w-3/4" />
                <USkeleton class="h-4 w-1/2" />
                <USkeleton class="h-2 w-full mt-3 rounded-full" />
              </div>
            </div>
          </div>
        </div>
        <div>
          <USkeleton class="h-6 w-36 mb-4" />
          <div
            class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-x-5 gap-y-8 justify-items-center mx-auto max-w-[1200px]"
          >
            <div v-for="i in 5" :key="i" class="w-full max-w-56 space-y-2">
              <USkeleton class="aspect-[2/3] w-full rounded-lg" />
              <USkeleton class="h-4 w-3/4" />
              <USkeleton class="h-3 w-1/2" />
            </div>
          </div>
        </div>
      </div>

      <ApiError
        v-else-if="status === 'error'"
        message="Could not load dashboard"
        @retry="refresh"
      />

      <div v-else-if="data" class="p-6 space-y-8">
        <!-- Stats Row -->
        <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div
            data-testid="stat-card-total-books"
            class="rounded-lg border border-default bg-default p-4"
          >
            <div class="flex items-center gap-2 mb-1">
              <UIcon name="i-lucide-library" class="text-primary" />
              <p class="text-sm text-muted">Total Books</p>
            </div>
            <p data-testid="stat-value-total-books" class="text-2xl font-semibold text-highlighted">
              {{ data.stats.totalBooks }}
            </p>
          </div>
          <RouterLink
            to="/inbox"
            data-testid="stat-card-awaiting-review"
            class="rounded-lg border border-default bg-default p-4 hover:border-primary transition-colors"
          >
            <div class="flex items-center gap-2 mb-1">
              <UIcon name="i-lucide-inbox" class="text-warning" />
              <p class="text-sm text-muted">Awaiting Review</p>
            </div>
            <p
              data-testid="stat-value-awaiting-review"
              class="text-2xl font-semibold text-highlighted"
            >
              {{ data.inboxCount }}
            </p>
          </RouterLink>
          <div
            data-testid="stat-card-processing"
            class="rounded-lg border border-default bg-default p-4"
          >
            <div class="flex items-center gap-2 mb-1">
              <UIcon
                name="i-lucide-loader-2"
                :class="data.stats.processingCount > 0 ? 'text-info animate-spin' : 'text-muted'"
              />
              <p class="text-sm text-muted">Processing</p>
            </div>
            <p data-testid="stat-value-processing" class="text-2xl font-semibold text-highlighted">
              {{ data.stats.processingCount }}
            </p>
          </div>
          <div
            data-testid="stat-card-library-size"
            class="rounded-lg border border-default bg-default p-4"
          >
            <div class="flex items-center gap-2 mb-1">
              <UIcon name="i-lucide-hard-drive" class="text-muted" />
              <p class="text-sm text-muted">Library Size</p>
            </div>
            <p
              data-testid="stat-value-library-size"
              class="text-2xl font-semibold text-highlighted"
            >
              {{ formatFileSize(data.stats.totalFileSize) }}
            </p>
          </div>
        </div>

        <!-- Currently Reading -->
        <section v-if="data.currentlyReading.length > 0" data-testid="currently-reading-section">
          <h2 class="text-lg font-semibold text-highlighted mb-4">Currently Reading</h2>
          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <RouterLink
              v-for="book in data.currentlyReading"
              :key="book.id"
              :to="`/library/${book.id}`"
              :data-testid="`currently-reading-card-${book.id}`"
              class="group flex gap-4 rounded-lg border border-default bg-default p-4 hover:border-primary transition-colors"
            >
              <div
                class="w-16 h-24 shrink-0 rounded overflow-hidden bg-elevated flex items-center justify-center"
              >
                <img
                  v-if="book.coverPath"
                  :src="`/api/library/${book.id}/cover`"
                  :alt="book.title ?? 'Book cover'"
                  loading="lazy"
                  decoding="async"
                  class="w-full h-full object-cover"
                />
                <UIcon v-else name="i-lucide-book-open" class="text-xl text-muted" />
              </div>
              <div class="flex-1 min-w-0">
                <p
                  class="font-medium text-highlighted truncate group-hover:text-primary transition-colors"
                >
                  {{ book.title ?? "Untitled" }}
                </p>
                <p class="text-sm text-muted truncate">{{ book.author ?? "Unknown Author" }}</p>
                <div class="mt-2">
                  <div class="flex items-center justify-between text-xs text-muted mb-1">
                    <span>{{ Math.round(book.percentage * 100) }}%</span>
                    <span>{{ book.device }}</span>
                  </div>
                  <UProgress :model-value="book.percentage * 100" size="sm" />
                </div>
                <p class="text-xs text-muted mt-1">{{ formatTimeAgo(book.lastRead) }}</p>
              </div>
            </RouterLink>
          </div>
        </section>

        <!-- Recently Added -->
        <section v-if="data.recentlyAdded.length > 0" data-testid="recently-added-section">
          <div class="flex items-center justify-between mb-4">
            <h2 class="text-lg font-semibold text-highlighted">Recently Added</h2>
            <RouterLink
              to="/library"
              data-testid="view-all-link"
              class="text-sm text-primary hover:underline"
            >
              View all
            </RouterLink>
          </div>
          <div
            class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-x-5 gap-y-8 justify-items-center mx-auto max-w-[1200px]"
          >
            <RouterLink
              v-for="book in data.recentlyAdded"
              :key="book.id"
              :to="`/library/${book.id}`"
              :data-testid="`recently-added-card-${book.id}`"
              class="group flex w-full max-w-56 flex-col gap-2"
            >
              <div
                class="aspect-[2/3] rounded-lg overflow-hidden bg-elevated shadow-sm group-hover:shadow-md transition-shadow"
              >
                <img
                  v-if="book.coverPath"
                  :src="`/api/library/${book.id}/cover`"
                  :alt="book.title ?? 'Book cover'"
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
                  {{ book.title ?? "Untitled" }}
                </p>
                <p class="text-xs text-muted truncate">{{ book.author ?? "Unknown Author" }}</p>
              </div>
            </RouterLink>
          </div>
        </section>

        <!-- Pipeline Status -->
        <section v-if="data.pipeline && pipelineHasActivity">
          <h2 class="text-lg font-semibold text-highlighted mb-4">Pipeline Status</h2>
          <!-- Summary row -->
          <div
            class="rounded-lg border border-default bg-default p-4 flex flex-wrap items-center gap-4"
          >
            <div v-if="pipelineTotals.active > 0" class="flex items-center gap-1.5 text-sm">
              <UIcon name="i-lucide-loader-2" class="text-info animate-spin" />
              <span class="text-muted">Active</span>
              <UBadge variant="subtle" color="info" size="sm">{{ pipelineTotals.active }}</UBadge>
            </div>
            <div v-if="pipelineTotals.waiting > 0" class="flex items-center gap-1.5 text-sm">
              <UIcon name="i-lucide-clock" class="text-warning" />
              <span class="text-muted">Waiting</span>
              <UBadge variant="subtle" color="warning" size="sm">{{
                pipelineTotals.waiting
              }}</UBadge>
            </div>
            <div v-if="pipelineTotals.delayed > 0" class="flex items-center gap-1.5 text-sm">
              <UIcon name="i-lucide-timer" class="text-muted" />
              <span class="text-muted">Delayed</span>
              <UBadge variant="subtle" color="neutral" size="sm">{{
                pipelineTotals.delayed
              }}</UBadge>
            </div>
            <div v-if="pipelineTotals.failed > 0" class="flex items-center gap-1.5 text-sm">
              <UIcon name="i-lucide-alert-circle" class="text-error" />
              <span class="text-muted">Failed</span>
              <UBadge variant="subtle" color="error" size="sm">{{ pipelineTotals.failed }}</UBadge>
            </div>
            <RouterLink
              v-if="pipelineTotals.failed > 0"
              to="/settings?tab=failed-jobs"
              class="ml-auto text-sm text-error hover:underline flex items-center gap-1"
            >
              <UIcon name="i-lucide-arrow-right" />
              View failed jobs
            </RouterLink>
          </div>
          <!-- Per-queue detail (only for active or failed queues) -->
          <div v-if="activeOrFailedQueues.length > 0" class="mt-3 space-y-2">
            <div
              v-for="[name, counts] in activeOrFailedQueues"
              :key="name"
              class="flex items-center gap-3 rounded-lg border border-default bg-default px-4 py-2.5 text-sm"
            >
              <span class="font-medium text-highlighted w-24 shrink-0">{{
                queueLabel(String(name))
              }}</span>
              <div class="flex items-center gap-3 flex-wrap">
                <span v-if="counts.active > 0" class="flex items-center gap-1">
                  <UBadge variant="subtle" color="info" size="sm"
                    >{{ counts.active }} active</UBadge
                  >
                </span>
                <span v-if="counts.failed > 0" class="flex items-center gap-1">
                  <UBadge variant="subtle" color="error" size="sm"
                    >{{ counts.failed }} failed</UBadge
                  >
                </span>
              </div>
            </div>
          </div>
        </section>

        <!-- Empty state -->
        <div
          v-if="
            data.currentlyReading.length === 0 &&
            data.recentlyAdded.length === 0 &&
            data.stats.totalBooks === 0
          "
          data-testid="empty-state"
          class="flex flex-col items-center justify-center py-16 text-center"
        >
          <UIcon name="i-lucide-book-open" class="text-4xl text-muted mb-3" />
          <p class="text-lg font-medium text-highlighted">Your library is empty</p>
          <p class="text-sm text-muted mt-1">Add books to your inbox folder to get started</p>
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
