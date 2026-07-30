<script setup lang="ts">
import { useQueryCache } from "@pinia/colada";

const queryCache = useQueryCache();
const { state, filters } = useJobsQuery();

const jobsStatus = computed(() => state.value.status);
const jobsData = computed(() => state.value.data);

// Queue list: derive from the settings status query
const { jobData } = useSettingsStatusQuery();
const queueNames = computed(() => {
  if (!jobData.value?.queues) return [];
  return Object.keys(jobData.value.queues).sort();
});

// Filters
const queueOptions = computed(() => [
  { label: "All Queues", value: "all" },
  ...queueNames.value.map((name) => ({
    label: formatQueueName(name),
    value: name,
  })),
]);

const statusOptions = [
  { label: "All Statuses", value: "all" },
  { label: "Completed", value: "completed" },
  { label: "Active", value: "active" },
  { label: "Waiting", value: "waiting" },
  { label: "Failed", value: "failed" },
  { label: "Delayed", value: "delayed" },
];

const selectedQueue = ref("all");
const selectedStatus = ref("all");

watch(selectedQueue, (val) => {
  filters.queue = val === "all" ? undefined : val;
  filters.page = 1;
});

watch(selectedStatus, (val) => {
  filters.status = val === "all" ? undefined : val;
  filters.page = 1;
});

// Job detail slideover
const detailOpen = ref(false);
const selectedJobId = ref<string | null>(null);
const selectedQueueName = ref<string | null>(null);

function openJobDetail(jobId: string, queueName: string) {
  selectedJobId.value = jobId;
  selectedQueueName.value = queueName;
  detailOpen.value = true;
}

function statusColor(status: string) {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "active") return "info";
  if (status === "delayed") return "warning";
  if (status === "waiting") return "neutral";
  return "neutral";
}

function formatTimestamp(ts: number) {
  return new Date(ts).toLocaleString();
}

function formatDuration(ms: number | null | undefined) {
  if (!ms && ms !== 0) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatQueueName(name: string) {
  return name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function refreshJobs() {
  queryCache.invalidateQueries({ key: ["jobs", "list"] });
}
</script>

<template>
  <div class="space-y-4 pt-6">
    <div class="flex items-center justify-between">
      <div>
        <h2 class="text-lg font-semibold">Jobs Browser</h2>
        <p class="text-sm text-muted mt-1">Browse and inspect recent jobs across all queues.</p>
      </div>
      <UButton
        icon="i-lucide-refresh-cw"
        variant="ghost"
        color="neutral"
        aria-label="Refresh jobs"
        data-testid="refresh-jobs-btn"
        @click="refreshJobs"
      />
    </div>

    <!-- Filters -->
    <div class="flex flex-wrap gap-3" data-testid="jobs-browser-filters">
      <USelect
        v-model="selectedQueue"
        :items="queueOptions"
        value-key="value"
        class="w-48"
        data-testid="filter-queue"
      />
      <USelect
        v-model="selectedStatus"
        :items="statusOptions"
        value-key="value"
        class="w-40"
        data-testid="filter-status"
      />
    </div>

    <!-- Loading state -->
    <div v-if="jobsStatus === 'pending'" class="space-y-3">
      <USkeleton v-for="i in 5" :key="i" class="h-14 w-full rounded-md" />
    </div>

    <!-- Error state -->
    <ApiError
      v-else-if="jobsStatus === 'error'"
      message="Could not load jobs"
      @retry="refreshJobs"
    />

    <!-- Empty state -->
    <div
      v-else-if="!jobsData?.jobs.length"
      class="text-center py-12"
      data-testid="jobs-browser-empty"
    >
      <UIcon name="i-lucide-inbox" class="text-4xl text-muted mx-auto mb-2" />
      <p class="text-sm text-muted">No jobs found matching your filters.</p>
    </div>

    <!-- Jobs list -->
    <div v-else class="space-y-2" data-testid="jobs-browser-list">
      <div
        v-for="job in jobsData.jobs"
        :key="job.id"
        class="rounded-md border border-default p-3 hover:bg-elevated/50 cursor-pointer transition-colors"
        :data-testid="`job-row-${job.id}`"
        @click="openJobDetail(job.id, job.queueName)"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm font-medium">{{ job.name }}</span>
              <UBadge
                :color="statusColor(job.status)"
                :label="job.status"
                variant="subtle"
                size="xs"
              />
              <UBadge
                :label="formatQueueName(job.queueName)"
                color="neutral"
                variant="subtle"
                size="xs"
              />
            </div>
            <div class="flex items-center gap-3 text-xs text-muted mt-1">
              <span>ID: {{ job.id }}</span>
              <span>{{ formatTimestamp(job.timestamp) }}</span>
              <span v-if="job.duration !== null && job.duration !== undefined">
                {{ formatDuration(job.duration) }}
              </span>
            </div>
          </div>
          <UIcon name="i-lucide-chevron-right" class="text-muted shrink-0" />
        </div>
      </div>

      <!-- Pagination -->
      <div
        v-if="jobsData.totalPages > 1"
        class="flex items-center justify-between pt-4"
        data-testid="jobs-browser-pagination"
      >
        <span class="text-xs text-muted">
          Page {{ jobsData.page }} of {{ jobsData.totalPages }} ({{ jobsData.total }} total)
        </span>
        <div class="flex gap-2">
          <UButton
            icon="i-lucide-chevron-left"
            aria-label="Previous jobs page"
            variant="outline"
            color="neutral"
            size="xs"
            :disabled="filters.page <= 1"
            data-testid="jobs-page-prev"
            @click="filters.page--"
          />
          <UButton
            icon="i-lucide-chevron-right"
            aria-label="Next jobs page"
            variant="outline"
            color="neutral"
            size="xs"
            :disabled="filters.page >= jobsData.totalPages"
            data-testid="jobs-page-next"
            @click="filters.page++"
          />
        </div>
      </div>
    </div>

    <!-- Job Detail Slideover -->
    <SettingsJobDetail
      v-model:open="detailOpen"
      :job-id="selectedJobId"
      :queue-name="selectedQueueName"
    />
  </div>
</template>
