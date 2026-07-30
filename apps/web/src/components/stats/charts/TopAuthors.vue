<script setup lang="ts">
import type { ECOption } from "~/types/echarts";

const { data } = defineProps<{
  data: Array<{ author: string; count: number }>;
}>();

// ECharts horizontal bar charts look best with the largest value at the top,
// which means the *data* order should be ascending (echarts draws y-axis
// bottom-to-top). The API returns desc, so reverse for display.
const displayData = computed(() => [...data].reverse());

const option = computed<ECOption>(() => ({
  grid: { top: 8, left: 140, right: 24, bottom: 24 },
  tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
  xAxis: { type: "value", minInterval: 1 },
  yAxis: {
    type: "category",
    data: displayData.value.map((a) => a.author),
    axisLabel: { width: 120, overflow: "truncate" },
  },
  series: [
    {
      type: "bar",
      data: displayData.value.map((a) => a.count),
      itemStyle: { borderRadius: [0, 4, 4, 0] },
    },
  ],
}));

const empty = computed(() => data.length === 0);
</script>

<template>
  <StatsStatChart
    title="Top Authors"
    testid="top-authors-chart"
    :option="option"
    :empty="empty"
    empty-message="No organized books yet"
    height="18rem"
  />
</template>
