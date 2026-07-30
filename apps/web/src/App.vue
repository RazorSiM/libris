<script setup lang="ts">
import { computed } from "vue";
import { useHead } from "@unhead/vue";
import { useColorMode } from "@vueuse/core";
import DefaultLayout from "./layouts/default.vue";

const colorMode = useColorMode();
useTheme();

const color = computed(() => (colorMode.value === "dark" ? "#1b1718" : "white"));

useHead({
  title: "Libris",
  titleTemplate: (title?: string) => (title && title !== "Libris" ? `${title} — Libris` : "Libris"),
  meta: [
    { name: "description", content: "Self-hosted book management" },
    { name: "theme-color", content: color },
  ],
  htmlAttrs: { lang: "en" },
});
</script>

<template>
  <UApp>
    <DefaultLayout>
      <RouterView />
    </DefaultLayout>
  </UApp>
</template>
