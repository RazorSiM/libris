<script setup lang="ts">
import { ref, onErrorCaptured } from "vue";

const error = ref<Error | null>(null);

onErrorCaptured((err) => {
  error.value = err instanceof Error ? err : new Error(String(err));
  // Stop propagation so the global error handler doesn't also toast.
  return false;
});

function clearError() {
  error.value = null;
}

defineExpose({ clearError });
</script>

<template>
  <slot v-if="!error" />
  <slot v-else name="error" :error="error" :clear-error="clearError" />
</template>
