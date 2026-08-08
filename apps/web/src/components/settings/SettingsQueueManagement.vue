<script setup lang="ts">
const toast = useToast();

const { state: settingsState, jobData } = useSettingsStatusQuery();
const settingsStatus = computed(() => settingsState.value.status);

const emit = defineEmits<{
  retry: [];
}>();

// Queue data with pause/resume state
const queueEntries = computed(() => {
  if (!jobData.value?.queues) return [];
  return Object.entries(
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
  ).sort(([a], [b]) => a.localeCompare(b));
});

const { mutateAsync: pauseQueue } = usePauseQueue();
const { mutateAsync: resumeQueue } = useResumeQueue();
const { mutateAsync: cleanQueue } = useCleanQueue();
const { mutateAsync: drainQueue } = useDrainQueue();

// Track loading state per queue per action
const loadingActions = reactive(new Map<string, string>());

// Confirmation dialog state
const confirmOpen = ref(false);
const confirmAction = ref<{
  type: "clean" | "drain";
  queueName: string;
} | null>(null);

function formatQueueName(name: string) {
  return name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

async function togglePause(queueName: string, isPaused: boolean) {
  const action = isPaused ? "resume" : "pause";
  loadingActions.set(queueName, action);
  try {
    if (isPaused) {
      await resumeQueue(queueName);
      toast.add({ title: `Queue "${formatQueueName(queueName)}" resumed`, color: "success" });
    } else {
      await pauseQueue(queueName);
      toast.add({ title: `Queue "${formatQueueName(queueName)}" paused`, color: "warning" });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : `Failed to ${action} queue`;
    toast.add({ title: message, color: "error" });
  } finally {
    loadingActions.delete(queueName);
  }
}

function requestClean(queueName: string) {
  confirmAction.value = { type: "clean", queueName };
  confirmOpen.value = true;
}

function requestDrain(queueName: string) {
  confirmAction.value = { type: "drain", queueName };
  confirmOpen.value = true;
}

async function executeConfirmedAction() {
  if (!confirmAction.value) return;
  const { type, queueName } = confirmAction.value;
  loadingActions.set(queueName, type);
  try {
    if (type === "clean") {
      const data = await cleanQueue(queueName);
      toast.add({
        title: `Cleaned ${data.removed} failed job(s) from "${formatQueueName(queueName)}"`,
        color: "success",
      });
    } else if (type === "drain") {
      await drainQueue(queueName);
      toast.add({
        title: `Queue "${formatQueueName(queueName)}" drained`,
        color: "success",
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : `Failed to ${type} queue`;
    toast.add({ title: message, color: "error" });
  } finally {
    loadingActions.delete(queueName);
    confirmAction.value = null;
  }
}

const confirmTitle = computed(() => {
  if (!confirmAction.value) return "";
  const { type, queueName } = confirmAction.value;
  if (type === "clean") return `Clean failed jobs from "${formatQueueName(queueName)}"?`;
  return `Drain queue "${formatQueueName(queueName)}"?`;
});

const confirmMessage = computed(() => {
  if (!confirmAction.value) return "";
  if (confirmAction.value.type === "clean") {
    return "This will permanently remove all failed jobs from this queue. This cannot be undone.";
  }
  return "This will remove all waiting and delayed jobs from this queue. Active jobs are not affected. This cannot be undone.";
});
</script>

<template>
  <div class="space-y-4 pt-6">
    <div>
      <h2 class="text-lg font-semibold">Queue Management</h2>
      <p class="text-sm text-muted mt-1">Pause, resume, clean, or drain individual queues.</p>
    </div>

    <div v-if="settingsStatus === 'pending'" class="space-y-3">
      <USkeleton v-for="i in 4" :key="i" class="h-20 w-full rounded-md" />
    </div>

    <ApiError
      v-else-if="settingsStatus === 'error'"
      message="Could not load queue data"
      @retry="emit('retry')"
    />

    <div v-else-if="queueEntries.length === 0" class="text-center py-12">
      <p class="text-sm text-muted">No queues found.</p>
    </div>

    <div v-else class="space-y-3" data-testid="queue-management-list">
      <div
        v-for="[queueName, counts] in queueEntries"
        :key="queueName"
        class="rounded-md border border-default p-4 space-y-3"
        :data-testid="`queue-card-${queueName}`"
      >
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium">{{ formatQueueName(queueName) }}</span>
            <UBadge
              v-if="counts.isPaused"
              label="PAUSED"
              color="warning"
              variant="subtle"
              size="xs"
            />
          </div>
          <div class="flex items-center gap-1">
            <UTooltip :text="counts.isPaused ? 'Resume queue' : 'Pause queue'">
              <UButton
                :icon="counts.isPaused ? 'i-lucide-play' : 'i-lucide-pause'"
                :aria-label="counts.isPaused ? 'Resume queue' : 'Pause queue'"
                size="xs"
                :color="counts.isPaused ? 'success' : 'warning'"
                variant="ghost"
                :loading="
                  loadingActions.get(queueName) === 'pause' ||
                  loadingActions.get(queueName) === 'resume'
                "
                :data-testid="`queue-toggle-pause-${queueName}`"
                @click="togglePause(queueName, counts.isPaused)"
              />
            </UTooltip>
            <UTooltip text="Clean failed jobs">
              <UButton
                icon="i-lucide-trash-2"
                aria-label="Clean failed jobs"
                size="xs"
                color="error"
                variant="ghost"
                :disabled="counts.failed === 0"
                :loading="loadingActions.get(queueName) === 'clean'"
                :data-testid="`queue-clean-${queueName}`"
                @click="requestClean(queueName)"
              />
            </UTooltip>
            <UTooltip text="Drain waiting jobs">
              <UButton
                icon="i-lucide-droplets"
                aria-label="Drain waiting jobs"
                size="xs"
                color="neutral"
                variant="ghost"
                :disabled="counts.waiting === 0 && counts.delayed === 0"
                :loading="loadingActions.get(queueName) === 'drain'"
                :data-testid="`queue-drain-${queueName}`"
                @click="requestDrain(queueName)"
              />
            </UTooltip>
          </div>
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
        </div>
      </div>
    </div>

    <!-- Confirmation Dialog -->
    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="confirmTitle"
      :message="confirmMessage"
      :confirm-label="confirmAction?.type === 'clean' ? 'Clean Failed Jobs' : 'Drain Queue'"
      :confirm-color="confirmAction?.type === 'clean' ? 'error' : 'warning'"
      :icon="confirmAction?.type === 'clean' ? 'i-lucide-trash-2' : 'i-lucide-droplets'"
      @confirm="executeConfirmedAction"
    />
  </div>
</template>
