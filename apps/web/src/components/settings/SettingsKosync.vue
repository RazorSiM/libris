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

const { appSettings, kosyncCredentials } = useSettingsStatusQuery();

const credentialSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
});

const kosyncCredForm = reactive({ username: "", password: "" });
const kosyncUsernameDirty = ref(false);
const { mutateAsync: putCredential, isLoading: kosyncSaving } = usePutCredential();

watch(
  () => kosyncCredentials.value?.username,
  (username) => {
    if (kosyncUsernameDirty.value) return;
    kosyncCredForm.username = username ?? "";
  },
  { immediate: true },
);

async function saveKosyncCredentials() {
  try {
    await putCredential({
      service: "kosync",
      username: kosyncCredForm.username,
      password: kosyncCredForm.password,
    });
    kosyncCredForm.password = "";
    toast.add({ title: "KoSync credentials saved", color: "success" });
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
        <UIcon name="i-lucide-book-open-check" class="text-primary" />
        <h3 class="text-sm font-semibold">KoSync (Reading Progress)</h3>
      </div>
      <p class="text-xs text-muted mt-1">
        Sync your reading position across KOReader devices. Progress appears on the Home dashboard.
      </p>
    </template>

    <div class="flex items-center justify-between gap-2">
      <div>
        <div class="text-xs text-muted font-medium uppercase tracking-wide">Server URL</div>
        <code class="text-sm" data-testid="kosync-url">{{ baseUrl }}/kosync</code>
      </div>
      <UTooltip text="Copy URL">
        <UButton
          icon="i-lucide-copy"
          aria-label="Copy KoSync URL"
          size="xs"
          variant="ghost"
          color="neutral"
          data-testid="kosync-copy-url"
          @click="copyToClipboard(`${baseUrl}/kosync`)"
        />
      </UTooltip>
    </div>

    <USeparator class="my-3" />

    <UAlert
      v-if="appSettings?.kosyncConfigured"
      icon="i-lucide-circle-check"
      :title="
        kosyncCredentials?.configured
          ? `KoSync credentials configured — username: ${kosyncCredentials.username}`
          : 'KoSync credentials are configured via environment variables.'
      "
      color="success"
      variant="subtle"
    />
    <UAlert
      v-else
      icon="i-lucide-circle-alert"
      title="KoSync is not configured"
      description="Set credentials below, or use environment variables on the server."
      color="warning"
      variant="subtle"
    />

    <UForm
      :schema="credentialSchema"
      :state="kosyncCredForm"
      class="rounded-md bg-elevated/50 p-3 space-y-2 mt-3"
      @submit="saveKosyncCredentials"
    >
      <h4 class="text-xs font-medium">Set KoSync Credentials</h4>
      <p class="text-xs text-muted">Set a username and password for KoReader sync.</p>
      <div class="flex flex-col sm:flex-row gap-2">
        <UFormField name="username" class="flex-1">
          <UInput
            v-model="kosyncCredForm.username"
            data-testid="kosync-username-input"
            placeholder="Username"
            size="sm"
            class="w-full"
            @update:model-value="kosyncUsernameDirty = true"
          />
        </UFormField>
        <UFormField name="password" class="flex-1">
          <UInput
            v-model="kosyncCredForm.password"
            data-testid="kosync-password-input"
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
          data-testid="kosync-save-btn"
          :loading="kosyncSaving"
        />
      </div>
    </UForm>

    <p class="text-xs text-muted mt-3">
      In KOReader: Settings → Cloud sync → Progress sync → Custom server
    </p>
  </UCard>
</template>
