<script setup lang="ts">
const { theme, themes } = useTheme();
</script>

<template>
  <USelect
    v-model="theme"
    :items="themes"
    value-key="value"
    label-key="label"
    icon="i-lucide-palette"
    data-testid="theme-picker"
  />
</template>
