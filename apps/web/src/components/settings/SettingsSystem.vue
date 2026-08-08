<script setup lang="ts">
const { state: settingsState, healthData, jobData } = useSettingsStatusQuery();

const settingsStatus = computed(() => settingsState.value.status);

const emit = defineEmits<{
  retry: [];
}>();

function healthStatusColor(status: string) {
  if (status === "ok") return "success";
  if (status === "degraded") return "warning";
  return "error";
}

const totalJobs = computed(() => {
  if (!jobData.value?.queues) return null;
  // `pausedQueues` counts queues, not jobs: a paused queue leaves its jobs in
  // `waiting`, so there is no separate pool of paused jobs to total up.
  const totals = { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, pausedQueues: 0 };
  for (const counts of Object.values(
    jobData.value.queues as Record<
      string,
      {
        waiting: number;
        active: number;
        completed: number;
        failed: number;
        delayed: number;
        isPaused: boolean;
      }
    >,
  )) {
    totals.waiting += counts.waiting;
    totals.active += counts.active;
    totals.completed += counts.completed;
    totals.failed += counts.failed;
    totals.delayed += counts.delayed;
    if (counts.isPaused) totals.pausedQueues += 1;
  }
  return totals;
});
</script>

<template>
  <div class="space-y-8 pt-6">
    <!-- Server Health -->
    <div class="space-y-3" data-testid="server-health-section">
      <div>
        <h2 class="text-lg font-semibold">Server Health</h2>
        <p class="text-sm text-muted mt-1">Status of backend services.</p>
      </div>

      <div v-if="settingsStatus === 'pending'" class="space-y-3">
        <USkeleton class="h-6 w-24 rounded-full" />
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <USkeleton v-for="i in 4" :key="i" class="h-20 w-full rounded-md" />
        </div>
      </div>

      <ApiError
        v-else-if="settingsStatus === 'error'"
        message="Could not load health data"
        @retry="emit('retry')"
      />

      <div v-else-if="healthData" class="space-y-3">
        <div class="flex items-center gap-2">
          <UBadge
            :color="healthStatusColor(healthData.status)"
            :label="healthData.status.toUpperCase()"
            variant="subtle"
          />
          <span class="text-sm text-muted">api</span>
        </div>

        <div v-if="healthData.checks" class="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div
            v-for="(check, name) in healthData.checks"
            :key="name"
            :data-testid="`health-card-${name}`"
            class="rounded-md border border-default p-3 space-y-1"
          >
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium capitalize">{{ name }}</span>
              <UBadge
                :color="healthStatusColor(check.status)"
                :label="check.status"
                size="xs"
                variant="subtle"
              />
            </div>
            <div v-if="check.latencyMs != null" class="text-xs text-muted">
              {{ check.latencyMs }}ms latency
            </div>
            <div v-if="check.error" class="text-xs text-error">
              {{ check.error }}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Queue Stats -->
    <div class="space-y-3" data-testid="job-queues-section">
      <div>
        <h2 class="text-lg font-semibold">Job Queues</h2>
        <p class="text-sm text-muted mt-1">BullMQ queue statistics.</p>
      </div>

      <div v-if="settingsStatus === 'pending'" class="space-y-3">
        <div class="grid grid-cols-3 sm:grid-cols-6 gap-2">
          <USkeleton v-for="i in 6" :key="i" class="h-16 w-full rounded-md" />
        </div>
        <USkeleton v-for="i in 3" :key="i" class="h-14 w-full rounded-md" />
      </div>

      <ApiError
        v-else-if="settingsStatus === 'error'"
        message="Could not load queue stats"
        @retry="emit('retry')"
      />

      <div v-else-if="jobData?.queues" class="space-y-3">
        <!-- Summary row -->
        <div v-if="totalJobs" class="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center">
          <div class="rounded-md border border-default p-2">
            <div class="text-lg font-semibold">{{ totalJobs.waiting }}</div>
            <div class="text-xs text-muted">Waiting</div>
          </div>
          <div class="rounded-md border border-default p-2">
            <div class="text-lg font-semibold text-info">{{ totalJobs.active }}</div>
            <div class="text-xs text-muted">Active</div>
          </div>
          <div class="rounded-md border border-default p-2">
            <div class="text-lg font-semibold text-success">{{ totalJobs.completed }}</div>
            <div class="text-xs text-muted">Completed</div>
          </div>
          <div class="rounded-md border border-default p-2">
            <div class="text-lg font-semibold text-error">{{ totalJobs.failed }}</div>
            <div class="text-xs text-muted">Failed</div>
          </div>
          <div class="rounded-md border border-default p-2">
            <div class="text-lg font-semibold text-warning">{{ totalJobs.delayed }}</div>
            <div class="text-xs text-muted">Delayed</div>
          </div>
          <div class="rounded-md border border-default p-2">
            <div class="text-lg font-semibold text-muted">{{ totalJobs.pausedQueues }}</div>
            <div class="text-xs text-muted">Paused queues</div>
          </div>
        </div>

        <!-- Per-queue breakdown -->
        <div
          v-for="(counts, queueName) in jobData.queues"
          :key="queueName"
          class="rounded-md border border-default p-3"
        >
          <div class="flex items-center justify-between mb-2">
            <span class="text-sm font-medium">{{ queueName }}</span>
          </div>
          <div class="flex flex-wrap gap-3 text-xs text-muted">
            <span
              >Waiting: <strong class="text-default">{{ counts.waiting }}</strong></span
            >
            <span
              >Active: <strong class="text-info">{{ counts.active }}</strong></span
            >
            <span
              >Completed: <strong class="text-success">{{ counts.completed }}</strong></span
            >
            <span
              >Failed: <strong class="text-error">{{ counts.failed }}</strong></span
            >
            <span
              >Delayed: <strong class="text-warning">{{ counts.delayed }}</strong></span
            >
            <span v-if="counts.isPaused" class="text-warning"><strong>Paused</strong></span>
          </div>
        </div>

        <p v-if="Object.keys(jobData.queues).length === 0" class="text-sm text-muted">
          No queues found.
        </p>
      </div>
    </div>
  </div>
</template>
