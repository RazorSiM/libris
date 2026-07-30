<script setup lang="ts">
import type { ECOption } from "~/types/echarts";

const { data } = defineProps<{
  data: Array<{ day: string; avgPages: number }>;
}>();

const option = computed<ECOption>(() => ({
  grid: { top: 16, left: 40, right: 16, bottom: 40 },
  tooltip: { trigger: "axis" },
  xAxis: {
    type: "category",
    data: data.map((r) => r.day),
    axisLabel: {
      formatter: (value: string) => value.slice(5), // MM-DD
      hideOverlap: true,
    },
  },
  yAxis: {
    type: "value",
    name: "pages/day",
    nameTextStyle: { align: "left" },
  },
  series: [
    {
      type: "line",
      smooth: true,
      showSymbol: false,
      areaStyle: { opacity: 0.15 },
      data: data.map((r) => r.avgPages),
    },
  ],
}));

const empty = computed(() => data.every((r) => r.avgPages === 0));
</script>

<template>
  <StatsStatChart
    title="Reading Velocity (7-day avg, last 90 days)"
    testid="velocity-chart"
    :option="option"
    :empty="empty"
    empty-message="No reading activity in the last 90 days"
    height="14rem"
  />
</template>
