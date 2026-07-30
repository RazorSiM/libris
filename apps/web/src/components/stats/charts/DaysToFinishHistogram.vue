<script setup lang="ts">
import type { ECOption } from "~/types/echarts";

const { data } = defineProps<{
  data: Array<{ bucket: string; count: number }>;
}>();

const option = computed<ECOption>(() => ({
  grid: { top: 16, left: 40, right: 16, bottom: 32 },
  tooltip: {
    trigger: "axis",
    axisPointer: { type: "shadow" },
    formatter: (p: unknown) => {
      const params = p as Array<{ name: string; value: number }>;
      if (!params.length) return "";
      const { name, value } = params[0]!;
      return `<div><strong>${name} days</strong><br/>${value} book${value === 1 ? "" : "s"}</div>`;
    },
  },
  xAxis: {
    type: "category",
    data: data.map((b) => b.bucket),
    name: "days",
    nameLocation: "middle",
    nameGap: 24,
  },
  yAxis: { type: "value", minInterval: 1 },
  series: [
    {
      type: "bar",
      data: data.map((b) => b.count),
      itemStyle: { borderRadius: [4, 4, 0, 0] },
    },
  ],
}));

const empty = computed(() => data.every((b) => b.count === 0));
</script>

<template>
  <StatsStatChart
    title="Days to Finish"
    testid="days-to-finish-chart"
    :option="option"
    :empty="empty"
    empty-message="Finish a couple of books to see your pace"
    height="14rem"
  />
</template>
