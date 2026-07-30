<script setup lang="ts">
import { useQuery } from "@pinia/colada";

interface JobDetail {
  id: string;
  queueName: string;
  name: string;
  data: Record<string, unknown>;
  status: string;
  progress?: number | Record<string, unknown>;
  returnValue?: unknown;
  failedReason?: string;
  stacktrace?: string[];
  attemptsMade: number;
  maxAttempts: number;
  timestamp: number;
  processedOn: number | null;
  finishedOn: number | null;
  duration: number | null;
}

interface JobLogs {
  jobId: string;
  logs: string[];
  count: number;
}

const { open, jobId, queueName } = defineProps<{
  open: boolean;
  jobId: string | null;
  queueName: string | null;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

const client = useApiClient();

const { data: jobDetail, status: detailStatus } = useQuery<JobDetail>({
  key: () => ["jobs", "detail", queueName ?? "none", jobId ?? "none"],
  query: async () => {
    if (!jobId || !queueName) throw new Error("Missing job ID or queue name");
    const res = await client.api.jobs[":id"].$get({
      param: { id: jobId },
      query: { queueName },
    });
    return res.json() as Promise<JobDetail>;
  },
  enabled: () => !!jobId && !!queueName && open,
  staleTime: 10_000,
});

const { data: logsData, status: logsStatus } = useQuery<JobLogs>({
  key: () => ["jobs", "logs", queueName ?? "none", jobId ?? "none"],
  query: async () => {
    if (!jobId || !queueName) throw new Error("Missing job ID or queue name");
    const res = await client.api.jobs[":id"].logs.$get({
      param: { id: jobId },
      query: { queueName },
    });
    return res.json() as Promise<JobLogs>;
  },
  enabled: () => !!jobId && !!queueName && open,
  staleTime: 10_000,
});

function statusColor(status: string) {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "active") return "info";
  if (status === "delayed") return "warning";
  if (status === "waiting") return "neutral";
  return "neutral";
}

function formatTimestamp(ts: number | null | undefined) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString();
}

function formatDuration(ms: number | null | undefined) {
  if (!ms && ms !== 0) return "-";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatQueueName(name: string) {
  return name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
</script>

<template>
  <USlideover
    :open="open"
    side="right"
    :title="jobId ? `Job ${jobId}` : 'Job Detail'"
    :description="jobDetail ? formatQueueName(jobDetail.queueName) : ''"
    data-testid="job-detail-slideover"
    @update:open="emit('update:open', $event)"
  >
    <template #body>
      <div v-if="detailStatus === 'pending'" class="space-y-3 p-1">
        <USkeleton class="h-6 w-32 rounded" />
        <USkeleton class="h-20 w-full rounded" />
        <USkeleton class="h-40 w-full rounded" />
      </div>

      <div v-else-if="detailStatus === 'error'" class="p-1">
        <ApiError message="Failed to load job details" />
      </div>

      <div v-else-if="jobDetail" class="space-y-5 p-1">
        <!-- Status + Meta -->
        <div class="flex items-center gap-2 flex-wrap">
          <UBadge
            :color="statusColor(jobDetail.status)"
            :label="jobDetail.status.toUpperCase()"
            variant="subtle"
            data-testid="job-detail-status"
          />
          <UBadge
            :label="formatQueueName(jobDetail.queueName)"
            color="neutral"
            variant="subtle"
            size="xs"
          />
          <UBadge
            :label="`${jobDetail.attemptsMade}/${jobDetail.maxAttempts} attempts`"
            color="warning"
            variant="subtle"
            size="xs"
          />
        </div>

        <!-- Timestamps -->
        <div class="space-y-1">
          <h3 class="text-sm font-semibold">Timestamps</h3>
          <div class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted">
            <span>Created</span>
            <span class="text-default" data-testid="job-detail-created">{{
              formatTimestamp(jobDetail.timestamp)
            }}</span>
            <span>Started</span>
            <span class="text-default">{{ formatTimestamp(jobDetail.processedOn) }}</span>
            <span>Finished</span>
            <span class="text-default">{{ formatTimestamp(jobDetail.finishedOn) }}</span>
            <span>Duration</span>
            <span class="text-default" data-testid="job-detail-duration">{{
              formatDuration(jobDetail.duration)
            }}</span>
          </div>
        </div>

        <!-- Job Payload -->
        <div class="space-y-1">
          <h3 class="text-sm font-semibold">Payload</h3>
          <pre
            class="rounded-md bg-elevated/50 p-3 text-xs font-mono overflow-x-auto max-h-48 overflow-y-auto"
            data-testid="job-detail-payload"
            >{{ JSON.stringify(jobDetail.data, null, 2) }}</pre>
        </div>

        <!-- Return Value (if present) -->
        <div v-if="jobDetail.returnValue" class="space-y-1">
          <h3 class="text-sm font-semibold">Return Value</h3>
          <pre
            class="rounded-md bg-elevated/50 p-3 text-xs font-mono overflow-x-auto max-h-32 overflow-y-auto"
            data-testid="job-detail-return-value"
            >{{ JSON.stringify(jobDetail.returnValue, null, 2) }}</pre>
        </div>

        <!-- Error / Stack Trace (if failed) -->
        <div v-if="jobDetail.failedReason" class="space-y-1">
          <h3 class="text-sm font-semibold text-error">Error</h3>
          <div
            class="rounded-md bg-error/5 border border-error/20 p-3 text-xs font-mono text-error break-all"
            data-testid="job-detail-error"
          >
            {{ jobDetail.failedReason }}
          </div>
        </div>

        <div v-if="jobDetail.stacktrace && jobDetail.stacktrace.length > 0" class="space-y-1">
          <h3 class="text-sm font-semibold text-error">Stack Trace</h3>
          <pre
            class="rounded-md bg-error/5 border border-error/20 p-3 text-xs font-mono text-error overflow-x-auto max-h-64 overflow-y-auto"
            data-testid="job-detail-stacktrace"
            >{{ jobDetail.stacktrace.join("\n") }}</pre>
        </div>

        <!-- Progress (if present) -->
        <div
          v-if="jobDetail.progress !== undefined && jobDetail.progress !== null"
          class="space-y-1"
        >
          <h3 class="text-sm font-semibold">Progress</h3>
          <div v-if="typeof jobDetail.progress === 'number'">
            <UProgress :value="jobDetail.progress" :max="100" />
            <span class="text-xs text-muted">{{ jobDetail.progress }}%</span>
          </div>
          <pre v-else class="rounded-md bg-elevated/50 p-3 text-xs font-mono overflow-x-auto">{{
            JSON.stringify(jobDetail.progress, null, 2)
          }}</pre>
        </div>

        <!-- Logs -->
        <div class="space-y-1">
          <h3 class="text-sm font-semibold">Logs</h3>
          <div v-if="logsStatus === 'pending'" class="space-y-2">
            <USkeleton v-for="i in 3" :key="i" class="h-4 w-full rounded" />
          </div>
          <div
            v-else-if="logsData && logsData.logs.length > 0"
            class="rounded-md bg-elevated/50 border border-default p-3 max-h-64 overflow-y-auto space-y-1"
            data-testid="job-detail-logs"
          >
            <div v-for="(line, i) in logsData.logs" :key="i" class="flex gap-2 text-xs font-mono">
              <span class="text-muted shrink-0 w-6 text-right">{{ i + 1 }}</span>
              <span class="text-default break-all">{{ line }}</span>
            </div>
          </div>
          <p v-else class="text-xs text-muted">No logs recorded for this job.</p>
        </div>
      </div>
    </template>
  </USlideover>
</template>
