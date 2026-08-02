<script setup lang="ts">
import { z } from "zod";
import { useClipboard } from "@vueuse/core";

const toast = useToast();
const { copy, copied } = useClipboard();

const { data: apiKeysData, status: apiKeysStatus } = useApiKeysQuery();
const { mutateAsync: createKey, isLoading: createPending } = useCreateApiKey();
const { mutateAsync: deleteKey } = useDeleteApiKey();

const deletingKeyId = ref<string | null>(null);
const pendingDeleteKeyId = ref<string | null>(null);

// New key form
const createSchema = z.object({
  label: z.string().min(1, "Label is required").max(50, "Max 50 characters"),
});
const createForm = reactive({ label: "" });

// Revealed key after creation
const revealedKey = ref<string | null>(null);

async function handleCreate() {
  try {
    const result = await createKey(createForm.label);
    revealedKey.value = result.key;
    createForm.label = "";
    toast.add({ title: "API key created", color: "success" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create key";
    toast.add({ title: message, color: "error" });
  }
}

async function handleDelete() {
  const keyId = pendingDeleteKeyId.value;
  pendingDeleteKeyId.value = null;
  if (!keyId) return;
  deletingKeyId.value = keyId;
  try {
    await deleteKey(keyId);
    toast.add({ title: "API key deleted", color: "success" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to delete key";
    toast.add({ title: message, color: "error" });
  } finally {
    deletingKeyId.value = null;
  }
}

function copyKey() {
  if (!revealedKey.value) return;
  copy(revealedKey.value);
  toast.add({ title: "API key copied to clipboard", color: "success" });
}

function dismissRevealedKey() {
  revealedKey.value = null;
}
</script>

<template>
  <div class="space-y-6 pt-6">
    <div>
      <h2 class="text-lg font-semibold">API Keys</h2>
      <p class="text-sm text-muted mt-1">Manage API keys for accessing this server.</p>
    </div>

    <!-- Revealed key banner -->
    <div
      v-if="revealedKey"
      data-testid="new-key-reveal"
      class="rounded-md border border-warning/30 bg-warning/5 p-4 space-y-3"
    >
      <div class="flex items-start gap-2">
        <UIcon name="i-lucide-triangle-alert" class="text-warning mt-0.5 shrink-0" />
        <p class="text-sm text-warning">Copy this key now. It cannot be retrieved later.</p>
      </div>
      <div class="flex items-center gap-2">
        <code
          class="flex-1 rounded-md border border-default bg-elevated px-3 py-2 text-sm font-mono select-all break-all"
          data-testid="new-key-value"
        >
          {{ revealedKey }}
        </code>
        <UButton
          :icon="copied ? 'i-lucide-check' : 'i-lucide-copy'"
          :color="copied ? 'success' : 'neutral'"
          aria-label="Copy new API key"
          variant="outline"
          size="md"
          data-testid="copy-new-key-btn"
          @click="copyKey"
        />
        <UButton
          icon="i-lucide-x"
          aria-label="Dismiss new API key"
          variant="ghost"
          color="neutral"
          size="md"
          data-testid="dismiss-new-key-btn"
          @click="dismissRevealedKey"
        />
      </div>
    </div>

    <!-- Create key form -->
    <UForm :schema="createSchema" :state="createForm" @submit="handleCreate">
      <div class="flex items-end gap-2">
        <UFormField name="label" label="New Key Label" class="flex-1">
          <UInput
            v-model="createForm.label"
            placeholder="e.g. My KoReader"
            class="w-full"
            data-testid="field-new-key-label"
          />
        </UFormField>
        <UButton
          type="submit"
          label="Create Key"
          icon="i-lucide-plus"
          color="primary"
          :loading="createPending"
          data-testid="create-key-btn"
        />
      </div>
    </UForm>

    <!-- Keys list -->
    <div v-if="apiKeysStatus === 'pending'" class="space-y-2">
      <USkeleton v-for="i in 3" :key="i" class="h-16 w-full rounded-lg" />
    </div>
    <div v-else-if="apiKeysData?.keys?.length" class="space-y-2">
      <div
        v-for="apiKeyItem in apiKeysData.keys"
        :key="apiKeyItem.id"
        :data-testid="`api-key-item-${apiKeyItem.id}`"
        class="flex items-center gap-3 p-3 rounded-lg bg-elevated"
      >
        <UIcon name="i-lucide-key-round" class="text-muted shrink-0" />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2">
            <span class="text-sm font-medium text-highlighted">
              {{ apiKeyItem.label }}
            </span>
            <UBadge
              v-if="apiKeyItem.isAdmin"
              variant="subtle"
              color="warning"
              size="xs"
              data-testid="admin-badge"
            >
              Admin
            </UBadge>
          </div>
          <div class="flex items-center gap-2 text-xs text-dimmed mt-0.5">
            <span>Created {{ new Date(apiKeyItem.createdAt).toLocaleDateString() }}</span>
            <span v-if="apiKeyItem.lastUsedAt">
              &middot; Last used {{ new Date(apiKeyItem.lastUsedAt).toLocaleDateString() }}
            </span>
          </div>
        </div>
        <UButton
          icon="i-lucide-trash-2"
          aria-label="Delete API key"
          variant="ghost"
          color="error"
          size="sm"
          :loading="deletingKeyId === apiKeyItem.id"
          :data-testid="`delete-key-btn-${apiKeyItem.id}`"
          @click="pendingDeleteKeyId = apiKeyItem.id"
        />
      </div>
    </div>
    <p v-else class="text-sm text-muted">No API keys found.</p>
  </div>

  <UModal
    :open="!!pendingDeleteKeyId"
    title="Delete API Key"
    description="This will permanently revoke access for anyone using this key. This action cannot be undone."
    @update:open="
      (v: boolean) => {
        if (!v) pendingDeleteKeyId = null;
      }
    "
  >
    <template #footer>
      <div class="flex gap-2 justify-end">
        <UButton
          label="Cancel"
          variant="ghost"
          data-testid="cancel-delete-key-btn"
          @click="pendingDeleteKeyId = null"
        />
        <UButton
          label="Delete"
          color="error"
          data-testid="confirm-delete-key-btn"
          @click="handleDelete()"
        />
      </div>
    </template>
  </UModal>
</template>
