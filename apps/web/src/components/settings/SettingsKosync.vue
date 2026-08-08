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

// `credentials.kosync` is the only KoSync signal in the status payload. The
// `settings` block used to carry a second `kosyncConfigured` flag computed from
// a table the kosync migration emptied, so this card showed "not configured"
// however many times you saved (libris-59m.18).
const { kosyncCredentials } = useSettingsStatusQuery();

const credentialSchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(12, "At least 12 characters"),
});

const kosyncCredForm = reactive({ username: "", password: "" });
const kosyncUsernameDirty = ref(false);
const passwordVisible = ref(false);
const { mutateAsync: putCredential, isLoading: kosyncSaving } = usePutCredential();

/**
 * A KoSync password is a device pairing secret, not an account password: it is
 * typed here once, typed into KOReader once, and never used again.
 *
 * KOReader sends md5(password) as the bearer secret and md5 adds no entropy, so
 * whatever the user picks here is what an offline attacker would enumerate if
 * the credential table ever leaked (libris-59m.24). The server pepper is what
 * makes that leak worthless; generating the value removes the human choice
 * underneath it as well, and stops anyone reusing their account password for a
 * credential that lives in plaintext on an e-reader.
 *
 * Look-alike characters are left out because this gets copied by hand onto a
 * device keyboard.
 */
const PAIRING_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const PAIRING_LENGTH = 16;

function generatePairingSecret(): string {
  // Rejection sampling: a bare modulo would favour the first few characters.
  const limit = Math.floor(0x1_0000_0000 / PAIRING_ALPHABET.length) * PAIRING_ALPHABET.length;
  const out: string[] = [];
  const buffer = new Uint32Array(PAIRING_LENGTH);
  while (out.length < PAIRING_LENGTH) {
    crypto.getRandomValues(buffer);
    for (const value of buffer) {
      if (out.length === PAIRING_LENGTH) break;
      if (value >= limit) continue;
      out.push(PAIRING_ALPHABET[value % PAIRING_ALPHABET.length]!);
    }
  }
  // Grouped for transcription, and the dashes count towards the 12-character
  // minimum the server enforces either way.
  return out.join("").replace(/(.{4})(?=.)/g, "$1-");
}

function fillGeneratedPassword() {
  kosyncCredForm.password = generatePairingSecret();
  passwordVisible.value = true;
  copyToClipboard(kosyncCredForm.password);
}

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
    passwordVisible.value = false;
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
      v-if="kosyncCredentials?.configured"
      icon="i-lucide-circle-check"
      data-testid="kosync-configured-alert"
      :title="`KoSync credentials configured — username: ${kosyncCredentials.username}`"
      color="success"
      variant="subtle"
    />
    <UAlert
      v-else
      icon="i-lucide-circle-alert"
      data-testid="kosync-unconfigured-alert"
      title="KoSync is not configured"
      description="Set a username and password below to pair a KOReader device."
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
      <p class="text-xs text-muted">
        Set a username and a password of at least 12 characters for KoReader sync. This password is
        a pairing secret for the device — use <strong>Generate</strong> rather than reusing your
        account password.
      </p>
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
            :type="passwordVisible ? 'text' : 'password'"
            placeholder="Password"
            size="sm"
            class="w-full"
          />
        </UFormField>
        <UTooltip text="Generate a random pairing secret and copy it">
          <UButton
            type="button"
            label="Generate"
            icon="i-lucide-dices"
            size="sm"
            color="neutral"
            variant="subtle"
            data-testid="kosync-generate-btn"
            @click="fillGeneratedPassword"
          />
        </UTooltip>
        <UButton
          type="submit"
          label="Save"
          size="sm"
          color="primary"
          data-testid="kosync-save-btn"
          :loading="kosyncSaving"
        />
      </div>
      <p v-if="passwordVisible" class="text-xs text-muted" data-testid="kosync-generated-hint">
        Copied to the clipboard. Enter it on the device now — it is not shown again after saving.
      </p>
    </UForm>

    <p class="text-xs text-muted mt-3">
      In KOReader: Settings → Cloud sync → Progress sync → Custom server
    </p>
  </UCard>
</template>
