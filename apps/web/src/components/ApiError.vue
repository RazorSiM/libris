<script setup lang="ts">
const { message, retryLabel } = defineProps<{
  message?: string;
  retryLabel?: string;
}>();

const emit = defineEmits<{
  retry: [];
}>();
</script>

<template>
  <div class="flex flex-col items-center justify-center py-12 gap-3 text-center">
    <UIcon name="i-lucide-alert-triangle" class="text-3xl text-error" />
    <p class="text-sm text-muted">{{ message || "Failed to load data" }}</p>
    <UButton
      data-testid="retry-btn"
      :label="retryLabel || 'Retry'"
      icon="i-lucide-refresh-cw"
      variant="outline"
      color="neutral"
      size="sm"
      @click="emit('retry')"
    />
  </div>
</template>
