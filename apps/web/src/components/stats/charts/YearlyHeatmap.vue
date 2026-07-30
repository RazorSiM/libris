<script setup lang="ts">
import type { ECOption } from "~/types/echarts";

const { year, days, availableYears } = defineProps<{
  year: number;
  days: Array<{ day: string; pages: number }>;
  availableYears: number[];
}>();

const emit = defineEmits<{ (e: "update:year", year: number): void }>();

const theme = useChartTheme();

const maxPages = computed(() => days.reduce((m, d) => (d.pages > m ? d.pages : m), 0));

// ECharts calendar dayLabel.nameMap: array of 7 strings starting from Sunday.
// Two-letter abbreviations are unambiguous in a tight column (vs. single-letter
// "T" that appears for both Tue and Thu, or "S" for Sat and Sun).
const DAY_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

const option = computed<ECOption>(() => ({
  tooltip: {
    trigger: "item",
    formatter: (p: unknown) => {
      const params = p as { value: [string, number] };
      const [date, pages] = params.value;
      return `<div><strong>${date}</strong><br/>${pages} pages</div>`;
    },
  },
  visualMap: {
    show: true,
    min: 0,
    max: Math.max(maxPages.value, 1),
    type: "continuous",
    orient: "horizontal",
    left: "center",
    bottom: 8,
    itemWidth: 12,
    itemHeight: 140,
    calculable: false,
    inRange: { color: theme.value.heatmap.gradient },
    text: [String(Math.max(maxPages.value, 1)), "0"],
    textStyle: { color: theme.value.categoryAxis.axisLabel.color, fontSize: 11 },
  },
  calendar: [
    {
      range: String(year),
      cellSize: ["auto", 14],
      top: 28,
      left: 40,
      right: 16,
      bottom: 56,
      splitLine: { show: false },
      itemStyle: {
        color: theme.value.heatmap.emptyBg,
        borderWidth: 1,
        borderColor: theme.value.heatmap.cellBorder,
      },
      yearLabel: { show: false },
      dayLabel: {
        firstDay: 1,
        nameMap: DAY_LABELS,
        color: theme.value.categoryAxis.axisLabel.color,
        fontSize: 11,
      },
      monthLabel: {
        nameMap: "en",
        color: theme.value.categoryAxis.axisLabel.color,
        fontSize: 11,
      },
    },
  ],
  series: [
    {
      type: "heatmap",
      coordinateSystem: "calendar",
      calendarIndex: 0,
      data: days.map((d) => [d.day, d.pages]),
      itemStyle: { borderWidth: 1, borderColor: theme.value.heatmap.cellBorder },
    },
  ],
}));

const empty = computed(() => days.length === 0);

function selectYear(value: string) {
  emit("update:year", Number(value));
}
</script>

<template>
  <StatsStatChart
    title="Pages Read"
    testid="activity-chart"
    :option="option"
    :empty="empty"
    :empty-message="`No reading activity in ${year}`"
    height="16rem"
  >
    <template #header-actions>
      <USelect
        v-if="availableYears.length > 1"
        :model-value="String(year)"
        :items="availableYears.map((y) => ({ label: String(y), value: String(y) }))"
        size="xs"
        data-testid="heatmap-year-picker"
        @update:model-value="selectYear"
      />
    </template>
  </StatsStatChart>
</template>
