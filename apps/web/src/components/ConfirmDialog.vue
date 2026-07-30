<script setup lang="ts">
const {
  open,
  title = "Are you sure?",
  message = "This action cannot be undone.",
  confirmLabel = "Confirm",
  confirmColor = "error",
  icon = "i-lucide-triangle-alert",
} = defineProps<{
  open: boolean;
  title?: string;
  message?: string;
  confirmLabel?: string;
  confirmColor?:
    | "error"
    | "warning"
    | "success"
    | "info"
    | "neutral"
    | "primary"
    | "secondary"
    | (string & {});
  icon?: string;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  confirm: [];
}>();

function close() {
  emit("update:open", false);
}

function confirm() {
  emit("confirm");
  close();
}
</script>

<template>
  <UModal :open="open" data-testid="confirm-dialog" @update:open="emit('update:open', $event)">
    <template #header>
      <div class="flex items-center gap-2">
        <UIcon :name="icon" class="text-error text-lg" />
        <h3 class="text-lg font-semibold text-highlighted">{{ title }}</h3>
      </div>
    </template>

    <template #body>
      <p class="text-sm text-muted">{{ message }}</p>
    </template>

    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          data-testid="confirm-dialog-cancel-btn"
          label="Cancel"
          variant="outline"
          color="neutral"
          @click="close"
        />
        <UButton
          data-testid="confirm-dialog-confirm-btn"
          :label="confirmLabel"
          :color="confirmColor as any"
          @click="confirm"
        />
      </div>
    </template>
  </UModal>
</template>
