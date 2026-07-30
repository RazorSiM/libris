<script setup lang="ts">
const open = defineModel<boolean>({ default: false });
</script>

<template>
  <UModal v-model:open="open" title="Keyboard Shortcuts">
    <template #body>
      <div class="space-y-3 text-sm">
        <div class="font-medium text-muted uppercase tracking-wider text-xs mb-2">Navigation</div>
        <div class="grid grid-cols-2 gap-2">
          <div class="flex items-center justify-between">
            <span>Home</span>
            <div class="flex gap-1"><UKbd>G</UKbd><UKbd>H</UKbd></div>
          </div>
          <div class="flex items-center justify-between">
            <span>Inbox</span>
            <div class="flex gap-1"><UKbd>G</UKbd><UKbd>I</UKbd></div>
          </div>
          <div class="flex items-center justify-between">
            <span>Library</span>
            <div class="flex gap-1"><UKbd>G</UKbd><UKbd>L</UKbd></div>
          </div>
          <div class="flex items-center justify-between">
            <span>Settings</span>
            <div class="flex gap-1"><UKbd>G</UKbd><UKbd>S</UKbd></div>
          </div>
        </div>
        <div class="font-medium text-muted uppercase tracking-wider text-xs mt-4 mb-2">General</div>
        <div class="flex items-center justify-between">
          <span>Show shortcuts</span>
          <UKbd>?</UKbd>
        </div>
      </div>
    </template>
  </UModal>
</template>
