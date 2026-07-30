<script setup lang="ts">
const { state: settingsState, appSettings } = useSettingsStatusQuery();

const settingsStatus = computed(() => settingsState.value.status);

const emit = defineEmits<{
  retry: [];
}>();
</script>

<template>
  <div class="space-y-3 pt-6">
    <div data-testid="app-settings-section">
      <h2 class="text-lg font-semibold">Application Settings</h2>
      <p class="text-sm text-muted mt-1">Library and inbox file paths configured on the server.</p>
    </div>

    <div v-if="settingsStatus === 'pending'" class="space-y-3">
      <USkeleton v-for="i in 2" :key="i" class="h-16 w-full rounded-md" />
    </div>

    <ApiError
      v-else-if="settingsStatus === 'error'"
      message="Could not load application settings"
      @retry="emit('retry')"
    />

    <div v-else-if="appSettings" class="space-y-3">
      <div data-testid="path-card-library" class="rounded-md border border-default p-3 space-y-1">
        <div class="text-xs text-muted font-medium uppercase tracking-wide">Library Path</div>
        <div data-testid="path-value-library" class="text-sm font-mono">
          {{ appSettings.libraryPath }}
        </div>
      </div>
      <div data-testid="path-card-inbox" class="rounded-md border border-default p-3 space-y-1">
        <div class="text-xs text-muted font-medium uppercase tracking-wide">Inbox Path</div>
        <div data-testid="path-value-inbox" class="text-sm font-mono">
          {{ appSettings.inboxPath }}
        </div>
      </div>
    </div>
  </div>
</template>
