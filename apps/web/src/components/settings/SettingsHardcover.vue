<script setup lang="ts">
import { z } from "zod";
import { useQueryCache } from "@pinia/colada";
import { formatDate } from "~/utils/formatters";

const toast = useToast();
const queryCache = useQueryCache();

const { appSettings, hardcoverCredentials } = useSettingsStatusQuery();

// Sync Hardcover toggle refs from aggregate data
const hardcoverMetadataEnabled = ref(true);
const hardcoverSyncEnabled = ref(true);

watch(
  () => appSettings.value,
  (settings) => {
    if (settings) {
      hardcoverMetadataEnabled.value = settings.hardcoverMetadataEnabled;
      hardcoverSyncEnabled.value = settings.hardcoverSyncEnabled;
    }
  },
  { immediate: true },
);

// --- Hardcover status (separate lazy query — external API is slow) ---
const hardcoverConfigured = computed(() => hardcoverCredentials.value?.configured ?? false);
const { data: hardcoverStatusData } = useHardcoverStatusQuery(hardcoverConfigured);

// --- Hardcover sync log (on-demand) ---
const hardcoverSyncLogOpen = ref(false);
const { data: hardcoverSyncLogData } = useHardcoverSyncLogQuery(hardcoverSyncLogOpen);

const hardcoverSyncing = ref(false);

// WebSocket: listen for real-time Hardcover sync updates — registers once when auth becomes true
const { isAuthenticated } = useAuth();
const { on } = useServerEvents();

whenever(
  isAuthenticated,
  () => {
    on("hardcover:sync-progress", (event) => {
      const data = event.payload as Record<string, unknown> | undefined;
      if (data?.phase === "syncing") {
        hardcoverSyncing.value = true;
      }
    });

    on("hardcover:sync-complete", () => {
      hardcoverSyncing.value = false;
      queryCache.invalidateQueries({ key: ["settings", "hardcover-status"] });
      if (hardcoverSyncLogOpen.value) {
        queryCache.invalidateQueries({ key: ["settings", "hardcover-sync-log"] });
      }
    });
  },
  { immediate: true, once: true },
);

const tokenSchema = z.object({
  token: z.string().min(1, "Token is required"),
});

const hardcoverTokenForm = reactive({ token: "" });
const hardcoverTokenVisible = ref(false);
const hardcoverEditing = ref(false);

const { mutateAsync: putCredential, isLoading: hardcoverSaving } = usePutCredential();
const { mutateAsync: deleteCredential, isLoading: hardcoverRemoving } = useDeleteCredential();
const { mutateAsync: triggerSync } = useTriggerHardcoverSync();
const { mutateAsync: patchSettings, isLoading: hardcoverTogglesLoading } = usePatchSettings();

async function saveHardcoverToken() {
  try {
    await putCredential({
      service: "hardcover",
      username: "hardcover",
      password: hardcoverTokenForm.token,
    });
    hardcoverTokenForm.token = "";
    hardcoverEditing.value = false;
    toast.add({ title: "Hardcover token saved", color: "success" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to save token";
    toast.add({ title: message, color: "error" });
  }
}

async function removeHardcoverToken() {
  try {
    await deleteCredential("hardcover");
    toast.add({ title: "Hardcover token removed", color: "success" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to remove token";
    toast.add({ title: message, color: "error" });
  }
}

async function triggerHardcoverSync() {
  hardcoverSyncing.value = true;
  try {
    await triggerSync();
    toast.add({ title: "Hardcover sync job enqueued", color: "success" });
  } catch (err: unknown) {
    hardcoverSyncing.value = false;
    const message = err instanceof Error ? err.message : "Failed to start sync";
    toast.add({ title: message, color: "error" });
  }
}

function toggleSyncLog() {
  hardcoverSyncLogOpen.value = !hardcoverSyncLogOpen.value;
}

async function updateHardcoverToggle(
  key: "hardcoverMetadataEnabled" | "hardcoverSyncEnabled",
  value: boolean,
) {
  try {
    await patchSettings({ [key]: value });
  } catch (err: unknown) {
    // Revert on failure
    if (key === "hardcoverMetadataEnabled") hardcoverMetadataEnabled.value = !value;
    else hardcoverSyncEnabled.value = !value;
    const message = err instanceof Error ? err.message : "Failed to update setting";
    toast.add({ title: message, color: "error" });
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-book-heart" class="text-primary" />
        <h3 class="text-sm font-semibold">Hardcover</h3>
      </div>
      <p class="text-xs text-muted mt-1">
        Used for book metadata enrichment during ingestion and to sync reading progress with your
        Hardcover account.
      </p>
    </template>

    <!-- Connection status -->
    <div data-testid="hardcover-status" class="flex items-center gap-2 mb-3">
      <span
        class="inline-block h-2.5 w-2.5 rounded-full"
        :class="hardcoverStatusData?.connected ? 'bg-success' : 'bg-error'"
      />
      <span class="text-sm">
        {{ hardcoverStatusData?.connected ? "Connected" : "Not connected" }}
      </span>
      <span
        v-if="hardcoverStatusData?.username"
        data-testid="hardcover-username"
        class="text-sm text-muted"
      >
        &mdash; {{ hardcoverStatusData.username }}
      </span>
      <span v-if="hardcoverStatusData?.error" class="text-xs text-error">
        ({{ hardcoverStatusData.error }})
      </span>
    </div>

    <div
      v-if="hardcoverStatusData?.lastSyncAt"
      data-testid="hardcover-last-sync"
      class="text-xs text-muted mb-3"
    >
      Last sync: {{ formatDate(hardcoverStatusData.lastSyncAt, { includeTime: true }) }}
    </div>

    <USeparator class="my-3" />

    <!-- Token input (when not configured or editing) -->
    <UForm
      v-if="!hardcoverCredentials?.configured || hardcoverEditing"
      :schema="tokenSchema"
      :state="hardcoverTokenForm"
      class="rounded-md bg-elevated/50 p-3 space-y-2"
      @submit="saveHardcoverToken"
    >
      <h4 class="text-xs font-medium">Hardcover API Token</h4>
      <p class="text-xs text-muted">
        Get your token at
        <a
          href="https://hardcover.app/account/api"
          target="_blank"
          rel="noopener noreferrer"
          class="underline text-primary"
          >hardcover.app/account/api</a
        >
      </p>
      <div class="flex flex-col sm:flex-row gap-2">
        <UFormField name="token" class="flex-1">
          <div class="relative w-full">
            <UInput
              v-model="hardcoverTokenForm.token"
              data-testid="hardcover-token-input"
              :type="hardcoverTokenVisible ? 'text' : 'password'"
              placeholder="Paste your Hardcover API token"
              size="sm"
              class="w-full"
            />
            <UButton
              :icon="hardcoverTokenVisible ? 'i-lucide-eye-off' : 'i-lucide-eye'"
              :aria-label="hardcoverTokenVisible ? 'Hide Hardcover token' : 'Show Hardcover token'"
              size="xs"
              variant="ghost"
              color="neutral"
              data-testid="hardcover-token-visibility-btn"
              class="absolute right-1 top-1/2 -translate-y-1/2"
              @click="hardcoverTokenVisible = !hardcoverTokenVisible"
            />
          </div>
        </UFormField>
        <UButton
          data-testid="hardcover-save-btn"
          type="submit"
          label="Save"
          size="sm"
          color="primary"
          :loading="hardcoverSaving"
        />
        <UButton
          v-if="hardcoverEditing"
          label="Cancel"
          size="sm"
          variant="ghost"
          color="neutral"
          data-testid="hardcover-cancel-btn"
          @click="hardcoverEditing = false"
        />
      </div>
    </UForm>

    <!-- Connected state -->
    <div v-else class="rounded-md bg-elevated/50 p-3 space-y-2">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-circle-check" class="text-success" />
          <span class="text-sm font-medium">Token configured</span>
        </div>
        <div class="flex items-center gap-2">
          <UButton
            data-testid="hardcover-update-btn"
            label="Update"
            size="xs"
            variant="outline"
            color="neutral"
            @click="hardcoverEditing = true"
          />
          <UButton
            data-testid="hardcover-remove-btn"
            label="Remove"
            size="xs"
            variant="outline"
            color="error"
            :loading="hardcoverRemoving"
            @click="removeHardcoverToken"
          />
        </div>
      </div>
    </div>

    <!-- Feature toggles -->
    <div v-if="hardcoverCredentials?.configured" class="mt-3 space-y-3">
      <div class="space-y-2">
        <div class="flex items-center justify-between">
          <div>
            <span class="text-sm font-medium" data-testid="hardcover-metadata-label"
              >Use as metadata source</span
            >
            <p class="text-xs text-muted">Search Hardcover for book metadata during ingestion</p>
          </div>
          <USwitch
            v-model="hardcoverMetadataEnabled"
            data-testid="hardcover-metadata-toggle"
            :loading="hardcoverTogglesLoading"
            @update:model-value="updateHardcoverToggle('hardcoverMetadataEnabled', $event)"
          />
        </div>
        <div class="flex items-center justify-between">
          <div>
            <span class="text-sm font-medium" data-testid="hardcover-sync-label"
              >Sync reading progress</span
            >
            <p class="text-xs text-muted">
              Push reading status and progress to your Hardcover account
            </p>
          </div>
          <USwitch
            v-model="hardcoverSyncEnabled"
            data-testid="hardcover-sync-toggle"
            :loading="hardcoverTogglesLoading"
            @update:model-value="updateHardcoverToggle('hardcoverSyncEnabled', $event)"
          />
        </div>
      </div>
    </div>

    <!-- Sync controls -->
    <div v-if="hardcoverCredentials?.configured" class="mt-3 space-y-3">
      <div class="flex items-center gap-2">
        <UButton
          data-testid="hardcover-sync-btn"
          label="Sync Now"
          size="sm"
          color="primary"
          icon="i-lucide-refresh-cw"
          :loading="hardcoverSyncing"
          :disabled="!hardcoverSyncEnabled && !hardcoverMetadataEnabled"
          @click="triggerHardcoverSync"
        />
      </div>

      <!-- Sync log toggle -->
      <div>
        <UButton
          :label="hardcoverSyncLogOpen ? 'Hide Sync Log' : 'Show Sync Log'"
          size="xs"
          variant="ghost"
          color="neutral"
          :icon="hardcoverSyncLogOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
          data-testid="hardcover-sync-log-toggle"
          @click="toggleSyncLog"
        />

        <div v-if="hardcoverSyncLogOpen" data-testid="hardcover-sync-log" class="mt-2">
          <div
            v-if="!hardcoverSyncLogData || hardcoverSyncLogData.length === 0"
            class="text-xs text-muted py-2"
          >
            No sync log entries yet.
          </div>
          <div v-else class="overflow-x-auto">
            <table class="w-full text-xs">
              <thead>
                <tr class="border-b border-default text-left text-muted">
                  <th class="pb-1 pr-3 font-medium">Book</th>
                  <th class="pb-1 pr-3 font-medium">Status</th>
                  <th class="pb-1 pr-3 font-medium">Progress</th>
                  <th class="pb-1 font-medium">Synced at</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="entry in hardcoverSyncLogData"
                  :key="entry.bookId"
                  class="border-b border-default last:border-0"
                >
                  <td class="py-1.5 pr-3">
                    {{ entry.bookTitle || entry.bookId }}
                  </td>
                  <td class="py-1.5 pr-3">
                    <UBadge
                      v-if="entry.status"
                      :label="entry.status"
                      size="xs"
                      variant="subtle"
                      color="neutral"
                    />
                    <span v-else class="text-muted">-</span>
                  </td>
                  <td class="py-1.5 pr-3">
                    {{ entry.progress ? `${Math.round(Number(entry.progress) * 100)}%` : "-" }}
                  </td>
                  <td class="py-1.5">
                    {{ formatDate(entry.syncedAt, { includeTime: true }) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  </UCard>
</template>
