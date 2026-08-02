<script setup lang="ts">
const { state: settingsState } = useSettingsStatusQuery();
const settingsStatus = computed(() => settingsState.value.status);
</script>

<template>
  <div class="space-y-6 pt-6">
    <div>
      <h2 class="text-lg font-semibold">Connections</h2>
      <p class="text-sm text-muted mt-1">Connect your e-readers and apps to this server.</p>
    </div>

    <!-- Skeleton loaders while aggregate query loads -->
    <template v-if="settingsStatus === 'pending'">
      <UCard v-for="i in 3" :key="i">
        <template #header>
          <div class="flex items-center gap-2">
            <USkeleton class="h-5 w-5 rounded" />
            <USkeleton class="h-4 w-32" />
          </div>
          <USkeleton class="h-3 w-48 mt-1" />
        </template>
        <div class="space-y-3">
          <USkeleton class="h-4 w-full" />
          <USkeleton class="h-px w-full" />
          <USkeleton class="h-8 w-full rounded-md" />
        </div>
      </UCard>
    </template>

    <template v-else>
      <!-- App passwords first: OPDS and KoSync both send you here for the
           credential, so the thing you need is above the things that need it. -->
      <SettingsAppPasswords />
      <SettingsOpds />
      <SettingsKosync />
      <SettingsHardcover />
    </template>
  </div>
</template>
