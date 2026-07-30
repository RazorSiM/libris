<script setup lang="ts">
import { z } from "zod";
import type { ReadingStatus } from "@libris/api-hono/types";

const { open, bookId, progress } = defineProps<{
  open: boolean;
  bookId: string;
  progress: {
    status: ReadingStatus | null;
    startedAt: string | null;
    finishedAt: string | null;
    pausedAt: string | null;
    manuallySet: boolean;
  } | null;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  saved: [];
}>();

const toast = useToast();
const { mutateAsync: setStatus, isLoading: saving } = useSetReadingStatus();
const { mutateAsync: clearStatus, isLoading: clearing } = useClearReadingStatus();

const STATUS_OPTIONS: { value: ReadingStatus; label: string }[] = [
  { value: "unread", label: "Unread" },
  { value: "reading", label: "Reading" },
  { value: "finished", label: "Read" },
  { value: "paused", label: "Paused" },
];

function isoToDateInput(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

function todayInput(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateInputToIso(input: string): string | null {
  if (!input) return null;
  return new Date(`${input}T00:00:00.000Z`).toISOString();
}

const dateFieldSchema = z
  .string()
  .refine((v) => !v || !isNaN(new Date(v).getTime()), "Invalid date")
  .refine((v) => {
    if (!v) return true;
    const today = todayInput();
    return v <= today;
  }, "Date cannot be in the future");

const schema = z
  .object({
    status: z.enum(["unread", "reading", "finished", "paused"]),
    startedAt: dateFieldSchema,
    finishedAt: dateFieldSchema,
    pausedAt: dateFieldSchema,
  })
  .refine(
    (data) => {
      if (data.status !== "finished" || !data.startedAt || !data.finishedAt) return true;
      return data.finishedAt >= data.startedAt;
    },
    { message: "Finished on must be on or after Started on", path: ["finishedAt"] },
  );

const state = reactive({
  status: "unread" as ReadingStatus,
  startedAt: "",
  finishedAt: "",
  pausedAt: "",
});

const formRef = ref<{ clear: () => void; submit: () => void } | null>(null);

watch(
  () => open,
  (val) => {
    if (val) {
      state.status = progress?.status ?? "unread";
      state.startedAt = isoToDateInput(progress?.startedAt ?? null);
      state.finishedAt = isoToDateInput(progress?.finishedAt ?? null);
      state.pausedAt = isoToDateInput(progress?.pausedAt ?? null);
      formRef.value?.clear();
    }
  },
);

watch(
  () => state.status,
  (next, prev) => {
    if (!open || next === prev) return;
    if (next === "finished" && !state.finishedAt) state.finishedAt = todayInput();
    if (next === "paused" && !state.pausedAt) state.pausedAt = todayInput();
  },
);

async function onSubmit(event: { data: z.output<typeof schema> }) {
  try {
    const d = event.data;
    await setStatus({
      id: bookId,
      body: {
        status: d.status,
        startedAt: d.status === "unread" ? null : (dateInputToIso(d.startedAt) ?? null),
        finishedAt: d.status === "finished" ? (dateInputToIso(d.finishedAt) ?? null) : null,
        pausedAt: d.status === "paused" ? (dateInputToIso(d.pausedAt) ?? null) : null,
      },
    });
    toast.add({ title: "Reading status updated", color: "success" });
    emit("saved");
    emit("update:open", false);
  } catch {
    toast.add({ title: "Failed to update reading status", color: "error" });
  }
}

async function onClearOverride() {
  try {
    await clearStatus(bookId);
    toast.add({ title: "Override cleared", color: "success" });
    emit("saved");
    emit("update:open", false);
  } catch {
    toast.add({ title: "Failed to clear override", color: "error" });
  }
}
</script>

<template>
  <UModal :open="open" @update:open="emit('update:open', $event)">
    <template #header>
      <h3 class="text-lg font-semibold text-highlighted">Edit Reading Status</h3>
    </template>

    <template #body>
      <UForm ref="formRef" :schema="schema" :state="state" @submit="onSubmit">
        <div class="space-y-4">
          <UFormField name="status" label="Status">
            <USelect
              v-model="state.status"
              :items="STATUS_OPTIONS"
              value-key="value"
              class="w-full"
              data-testid="field-reading-status"
            />
          </UFormField>

          <UFormField
            v-if="state.status !== 'unread'"
            name="startedAt"
            label="Started on"
            :hint="state.status === 'reading' ? undefined : 'Optional'"
          >
            <UInput
              v-model="state.startedAt"
              type="date"
              :max="todayInput()"
              class="w-full"
              data-testid="field-started-at"
            />
          </UFormField>

          <UFormField v-if="state.status === 'finished'" name="finishedAt" label="Finished on">
            <UInput
              v-model="state.finishedAt"
              type="date"
              :max="todayInput()"
              class="w-full"
              data-testid="field-finished-at"
            />
          </UFormField>

          <UFormField v-if="state.status === 'paused'" name="pausedAt" label="Paused on">
            <UInput
              v-model="state.pausedAt"
              type="date"
              :max="todayInput()"
              class="w-full"
              data-testid="field-paused-at"
            />
          </UFormField>

          <p v-if="progress?.manuallySet" class="text-xs text-dimmed">
            This status is manually overridden. KoReader sync will not change it until cleared.
          </p>
        </div>
      </UForm>
    </template>

    <template #footer>
      <div class="flex justify-between w-full">
        <UButton
          v-if="progress?.manuallySet"
          label="Clear override"
          variant="outline"
          color="neutral"
          :loading="clearing"
          data-testid="clear-override-btn"
          @click="onClearOverride"
        />
        <span v-else />
        <div class="flex gap-2">
          <UButton
            label="Cancel"
            variant="outline"
            color="neutral"
            data-testid="cancel-btn"
            @click="emit('update:open', false)"
          />
          <UButton
            label="Save"
            color="primary"
            :loading="saving"
            data-testid="save-btn"
            @click="formRef?.submit()"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
