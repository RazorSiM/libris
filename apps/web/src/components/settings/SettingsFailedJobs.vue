<script setup lang="ts">
const toast = useToast();

const { state: settingsState, failedJobsData } = useSettingsStatusQuery();

const settingsStatus = computed(() => settingsState.value.status);

const emit = defineEmits<{
  retry: [];
}>();

const { mutateAsync: retryJobMutation } = useRetryJob();
const retryingJobs = reactive(new Set<string>());

const detailOpen = ref(false);
const selectedJobId = ref<string | null>(null);
const selectedQueueName = ref<string | null>(null);

function openJobDetail(jobId: string, queueName: string) {
  selectedJobId.value = jobId;
  selectedQueueName.value = queueName;
  detailOpen.value = true;
}

async function retryJob(jobId: string, queueName: string, event: Event) {
  event.stopPropagation();
  retryingJobs.add(jobId);
  try {
    await retryJobMutation({ id: jobId, queueName });
    toast.add({ title: "Job queued for retry", color: "success" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Retry failed";
    toast.add({ title: message, color: "error" });
  } finally {
    retryingJobs.delete(jobId);
  }
}

function formatTimestamp(ts: number) {
  return new Date(ts).toLocaleString();
}

function formatQueueName(name: string) {
  return name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
</script>

<template>
  <div class="space-y-3 pt-6">
    <div>
      <h2 class="text-lg font-semibold">Failed Jobs</h2>
      <p class="text-sm text-muted mt-1">
        Jobs that failed after exhausting all retry attempts. Click a job to view details.
      </p>
    </div>

    <div v-if="settingsStatus === 'pending'" class="space-y-3">
      <USkeleton v-for="i in 3" :key="i" class="h-20 w-full rounded-md" />
    </div>

    <ApiError
      v-else-if="settingsStatus === 'error'"
      message="Could not load failed jobs"
      @retry="emit('retry')"
    />

    <div v-else-if="failedJobsData.jobs.length === 0" class="text-center py-12">
      <UIcon name="i-lucide-check-circle" class="text-4xl text-success mx-auto mb-2" />
      <p class="text-lg font-medium text-highlighted">No failed jobs</p>
      <p class="text-sm text-muted">All pipeline jobs are running smoothly.</p>
    </div>

    <div v-else class="space-y-3">
      <div
        v-for="job in failedJobsData.jobs"
        :key="job.id"
        class="rounded-md border border-default p-4 space-y-2 hover:bg-elevated/50 cursor-pointer transition-colors"
        :data-testid="`failed-job-${job.id}`"
        @click="openJobDetail(job.id, job.queueName)"
      >
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-sm font-medium">Job {{ job.id }}</span>
              <UBadge
                :label="formatQueueName(job.queueName)"
                color="neutral"
                variant="subtle"
                size="xs"
              />
              <UBadge
                :label="`${job.attemptsMade}/${job.maxAttempts} attempts`"
                color="warning"
                variant="subtle"
                size="xs"
              />
            </div>
            <div v-if="job.data?.title || job.data?.filePath" class="text-sm text-muted mt-1">
              {{ job.data?.title || (job.data?.filePath as string)?.split("/").pop() || job.name }}
            </div>
          </div>
          <UButton
            icon="i-lucide-rotate-ccw"
            label="Retry"
            size="xs"
            color="primary"
            variant="outline"
            :loading="retryingJobs.has(job.id)"
            :data-testid="`retry-job-${job.id}`"
            @click="(e: Event) => retryJob(job.id, job.queueName, e)"
          />
        </div>
        <div class="rounded bg-elevated/50 p-2 text-xs font-mono text-error break-all">
          {{ job.error }}
        </div>
        <div class="flex items-center justify-between">
          <div class="text-xs text-muted">Failed {{ formatTimestamp(job.failedAt) }}</div>
          <UIcon name="i-lucide-chevron-right" class="text-muted text-xs" />
        </div>
      </div>
    </div>

    <SettingsJobDetail
      v-model:open="detailOpen"
      :job-id="selectedJobId"
      :queue-name="selectedQueueName"
    />
  </div>
</template>
