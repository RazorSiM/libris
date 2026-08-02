<script setup lang="ts">
import { useClipboard } from "@vueuse/core";

const toast = useToast();
const { copy } = useClipboard();

const baseUrl = computed(() => window.location.origin);

function copyToClipboard(text: string) {
  copy(text);
  toast.add({ title: "Copied to clipboard", color: "success" });
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

    <!--
      The separate OPDS username/password is gone. A reader signs in with your
      own account name and an app password, so there is no second credential to
      set up here and no way to end up with OPDS access you forgot you granted.
      The proper devices UI is libris-5ng.21.
    -->
    <div class="text-xs text-muted space-y-1">
      <p>
        <strong>Auth:</strong> HTTP Basic. Use your account email as the username and an
        <strong>app password</strong> as the password.
      </p>
      <p data-testid="opds-app-password-hint">
        Create one under App Passwords above — the password is shown once, when you create it.
      </p>
    </div>
  </UCard>
</template>
