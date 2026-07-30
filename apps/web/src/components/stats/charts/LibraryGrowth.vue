<script setup lang="ts">
import type { ECOption } from "~/types/echarts";

const { data } = defineProps<{
  data: Array<{ month: string; cumulative: number }>;
}>();

const option = computed<ECOption>(() => ({
  grid: { top: 16, left: 40, right: 16, bottom: 40 },
  tooltip: {
    trigger: "axis",
    formatter: (p: unknown) => {
      const params = p as Array<{ name: string; value: number }>;
      if (!params.length) return "";
      const { name, value } = params[0]!;
      return `<div><strong>${name}</strong><br/>${value} book${value === 1 ? "" : "s"} in library</div>`;
    },
  },
  xAxis: {
    type: "category",
    data: data.map((l) => l.month),
    axisLabel: { hideOverlap: true },
  },
  yAxis: { type: "value", minInterval: 1 },
  series: [
    {
      type: "line",
      step: "end",
      smooth: false,
      showSymbol: false,
      areaStyle: { opacity: 0.15 },
      data: data.map((l) => l.cumulative),
    },
  ],
}));

const empty = computed(() => data.length === 0);
</script>

<template>
  <StatsStatChart
    title="Library Growth"
    testid="library-growth-chart"
    :option="option"
    :empty="empty"
    empty-message="Add some books to start your library"
    height="14rem"
  />
</template>
