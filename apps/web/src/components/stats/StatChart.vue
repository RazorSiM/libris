<script setup lang="ts">
import type { ECOption } from "~/types/echarts";

const { title, testid, option, height, empty, emptyMessage, loading } = defineProps<{
  title: string;
  testid: string;
  option: ECOption;
  height?: string;
  /** True when the underlying dataset is empty — renders the default/named empty slot. */
  empty?: boolean;
  emptyMessage?: string;
  loading?: boolean;
}>();

const theme = useChartTheme();
</script>

<template>
  <section>
    <div class="flex items-center justify-between mb-4">
      <h2 class="text-lg font-semibold text-highlighted">{{ title }}</h2>
      <div class="flex items-center gap-2">
        <slot name="header-actions" />
      </div>
    </div>
    <div :data-testid="testid" class="rounded-lg border border-default bg-default p-4">
      <USkeleton
        v-if="loading"
        class="w-full rounded"
        :class="height ? '' : 'h-64'"
        :style="height ? `height: ${height}` : undefined"
      />
      <div v-else-if="empty" class="py-8 text-center text-muted">
        <slot name="empty">
          <p>{{ emptyMessage ?? "No data yet" }}</p>
        </slot>
      </div>
      <VChart
        v-else
        :option="option"
        :theme="theme"
        autoresize
        :style="{ height: height ?? '16rem' }"
      />
    </div>
  </section>
</template>
