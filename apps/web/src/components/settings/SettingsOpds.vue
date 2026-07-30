<script setup lang="ts">
import { z } from "zod";
import { useClipboard } from "@vueuse/core";

const toast = useToast();
const { copy } = useClipboard();

const baseUrl = computed(() => window.location.origin);

function copyToClipboard(text: string) {
  copy(text);
  toast.add({ title: "Copied to clipboard", color: "success" });
}

const { opdsCredentials } = useSettingsStatusQuery();

const credentialSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

const opdsCredForm = reactive({ username: "", password: "" });
const opdsUsernameDirty = ref(false);
const { mutateAsync: putCredential, isLoading: opdsSaving } = usePutCredential();

watch(
  () => opdsCredentials.value?.username,
  (username) => {
    if (opdsUsernameDirty.value) return;
    opdsCredForm.username = username ?? "";
  },
  { immediate: true },
);

async function saveOpdsCredentials() {
  try {
    await putCredential({
      service: "opds",
      username: opdsCredForm.username,
      password: opdsCredForm.password,
    });
    opdsCredForm.password = "";
    toast.add({ title: "OPDS credentials saved", color: "success" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to save credentials";
    toast.add({ title: message, color: "error" });
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon name="i-lucide-rss" class="text-primary" />
        <h3 class="text-sm font-semibold">OPDS Catalog</h3>
      </div>
      <p class="text-xs text-muted mt-1">
        Browse and download books from any OPDS-compatible reader (KOReader, Calibre, Marvin, etc).
      </p>
    </template>

    <div class="flex items-center justify-between gap-2">
      <div>
        <div class="text-xs text-muted font-medium uppercase tracking-wide">Catalog URL</div>
        <code class="text-sm" data-testid="opds-url">{{ baseUrl }}/opds</code>
      </div>
      <UTooltip text="Copy URL">
        <UButton
          icon="i-lucide-copy"
          aria-label="Copy OPDS URL"
          size="xs"
          variant="ghost"
          color="neutral"
          data-testid="opds-copy-url"
          @click="copyToClipboard(`${baseUrl}/opds`)"
        />
      </UTooltip>
    </div>

    <USeparator class="my-3" />

    <div class="space-y-3">
      <div class="text-xs text-muted">
        <p v-if="opdsCredentials?.configured">
          <strong>Auth:</strong> HTTP Basic — username:
          <code class="bg-elevated/50 px-1 rounded">{{ opdsCredentials.username }}</code>
        </p>
        <p v-else>
          <UIcon name="i-lucide-alert-triangle" class="text-warning inline" />
          <strong>Auth:</strong> Not configured — set credentials below to enable OPDS access.
        </p>
      </div>

      <UForm
        :schema="credentialSchema"
        :state="opdsCredForm"
        class="rounded-md bg-elevated/50 p-3 space-y-2"
        @submit="saveOpdsCredentials"
      >
        <h4 class="text-xs font-medium">OPDS Credentials</h4>
        <p class="text-xs text-muted">
          Set a username and password for OPDS clients (KOReader, Calibre, etc).
        </p>
        <div class="flex flex-col sm:flex-row gap-2">
          <UFormField name="username" class="flex-1">
            <UInput
              v-model="opdsCredForm.username"
              data-testid="opds-username-input"
              placeholder="Username"
              size="sm"
              class="w-full"
              @update:model-value="opdsUsernameDirty = true"
            />
          </UFormField>
          <UFormField name="password" class="flex-1">
            <UInput
              v-model="opdsCredForm.password"
              data-testid="opds-password-input"
              type="password"
              placeholder="Password"
              size="sm"
              class="w-full"
            />
          </UFormField>
          <UButton
            type="submit"
            label="Save"
            size="sm"
            color="primary"
            data-testid="opds-save-btn"
            :loading="opdsSaving"
          />
        </div>
      </UForm>
    </div>
  </UCard>
</template>
