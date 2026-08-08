<script setup lang="ts">
import { computed } from "vue";
import { useHead } from "@unhead/vue";
import { useColorMode } from "@vueuse/core";
import AuthLayout from "./layouts/auth.vue";
import DefaultLayout from "./layouts/default.vue";

const colorMode = useColorMode();
const route = useRoute();
useTheme();

const color = computed(() => (colorMode.value === "dark" ? "#1b1718" : "white"));
const layout = computed(() => (route.meta.layout === false ? AuthLayout : DefaultLayout));

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
    <component :is="layout">
      <RouterView />
    </component>
  </UApp>
</template>
