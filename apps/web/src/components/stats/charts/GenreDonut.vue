<script setup lang="ts">
import type { ECOption } from "~/types/echarts";

const { data } = defineProps<{
  data: Array<{ genre: string; count: number }>;
}>();

const total = computed(() => data.reduce((s, g) => s + g.count, 0));

const option = computed<ECOption>(() => ({
  tooltip: {
    trigger: "item",
    formatter: (p: unknown) => {
      const { name, value, percent } = p as { name: string; value: number; percent: number };
      return `<div><strong>${name}</strong><br/>${value} book${value === 1 ? "" : "s"} (${percent}%)</div>`;
    },
  },
  legend: {
    type: "scroll",
    orient: "horizontal",
    bottom: 0,
    left: "center",
  },
  series: [
    {
      type: "pie",
      radius: ["45%", "70%"],
      center: ["50%", "45%"],
      avoidLabelOverlap: true,
      padAngle: 2,
      itemStyle: { borderRadius: 6 },
      label: { show: false },
      emphasis: { label: { show: true, fontSize: 14, fontWeight: "bold" } },
      data: data.map((g) => ({ name: g.genre, value: g.count })),
    },
  ],
}));

const empty = computed(() => total.value === 0);
</script>

<template>
  <StatsStatChart
    title="Genres (Finished Books)"
    testid="genre-chart"
    :option="option"
    :empty="empty"
    empty-message="No genre data for finished books"
    height="18rem"
  />
</template>
