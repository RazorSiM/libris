<script setup lang="ts">
import type { ECOption } from "~/types/echarts";

const { data } = defineProps<{
  data: Array<{ month: string; count: number }>;
}>();

const monthLabel = (m: string): string => {
  const [, mm] = m.split("-");
  const names = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return names[Number(mm) - 1] ?? m;
};

const option = computed<ECOption>(() => ({
  grid: { top: 16, left: 40, right: 16, bottom: 28 },
  tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
  xAxis: {
    type: "category",
    data: data.map((m) => monthLabel(m.month)),
  },
  yAxis: { type: "value", minInterval: 1 },
  series: [
    {
      type: "bar",
      data: data.map((m) => m.count),
      itemStyle: { borderRadius: [4, 4, 0, 0] },
    },
  ],
}));

const empty = computed(() => data.every((m) => m.count === 0));
</script>

<template>
  <StatsStatChart
    title="Books Finished Per Month"
    testid="finished-per-month-chart"
    :option="option"
    :empty="empty"
    empty-message="No finished books this year"
    height="14rem"
  />
</template>
