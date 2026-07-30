<script setup lang="ts">
useHead({ title: "Stats" });

const heatmapYear = ref(new Date().getFullYear());
const { data, status, refresh } = useStatsQuery(heatmapYear);

// Offer year picker options for the last 5 calendar years + any year that
// already has heatmap data on the current year's payload. Keeps the UI
// honest: if the user has older data we surface it, otherwise we don't
// show empty pickers past the app's realistic history.
const availableYears = computed(() => {
  const current = new Date().getFullYear();
  const years = new Set<number>();
  for (let y = current; y >= current - 4; y--) years.add(y);
  const payloadYear = data.value?.pagesHeatmap.year;
  if (payloadYear != null) years.add(payloadYear);
  return Array.from(years).sort((a, b) => b - a);
});
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <UDashboardNavbar title="Reading Stats">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <ColorModeToggle />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <!-- Loading skeletons -->
      <div v-if="status === 'pending'" class="p-6 space-y-8">
        <div class="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <div
            v-for="i in 5"
            :key="i"
            class="rounded-lg border border-default bg-default p-4 space-y-2"
          >
            <USkeleton class="h-4 w-28" />
            <USkeleton class="h-8 w-16" />
          </div>
        </div>
        <div>
          <USkeleton class="h-6 w-52 mb-4" />
          <div class="rounded-lg border border-default bg-default p-4">
            <USkeleton class="h-56 w-full rounded" />
          </div>
        </div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div v-for="i in 4" :key="i">
            <USkeleton class="h-6 w-44 mb-4" />
            <div class="rounded-lg border border-default bg-default p-4">
              <USkeleton class="h-56 w-full rounded" />
            </div>
          </div>
        </div>
      </div>

      <ApiError v-else-if="status === 'error'" message="Could not load stats" @retry="refresh" />

      <div v-else-if="data" class="p-6 space-y-8">
        <!-- Top Stats Cards -->
        <div class="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <div
            data-testid="stat-card-finished-all-time"
            class="rounded-lg border border-default bg-default p-4"
          >
            <p class="text-sm text-muted">Finished (All Time)</p>
            <p
              data-testid="stat-value-finished-all-time"
              class="text-2xl font-semibold text-highlighted"
            >
              {{ data.booksFinished.allTime }}
            </p>
          </div>
          <div
            data-testid="stat-card-finished-this-year"
            class="rounded-lg border border-default bg-default p-4"
          >
            <p class="text-sm text-muted">Finished (This Year)</p>
            <p
              data-testid="stat-value-finished-this-year"
              class="text-2xl font-semibold text-highlighted"
            >
              {{ data.booksFinished.thisYear }}
            </p>
          </div>
          <div
            data-testid="stat-card-finished-this-month"
            class="rounded-lg border border-default bg-default p-4"
          >
            <p class="text-sm text-muted">Finished (This Month)</p>
            <p
              data-testid="stat-value-finished-this-month"
              class="text-2xl font-semibold text-highlighted"
            >
              {{ data.booksFinished.thisMonth }}
            </p>
          </div>
          <div
            data-testid="stat-card-reading-streak"
            class="rounded-lg border border-default bg-default p-4"
          >
            <p class="text-sm text-muted">Reading Streak</p>
            <p
              data-testid="stat-value-reading-streak"
              class="text-2xl font-semibold text-highlighted"
            >
              {{ data.streak.current }}
              <span class="text-sm font-normal text-muted">days</span>
            </p>
            <p class="text-xs text-muted mt-1">Longest: {{ data.streak.longest }} days</p>
          </div>
          <div
            data-testid="stat-card-avg-time-to-finish"
            class="rounded-lg border border-default bg-default p-4"
          >
            <p class="text-sm text-muted">Avg. Time to Finish</p>
            <p
              data-testid="stat-value-avg-time-to-finish"
              class="text-2xl font-semibold text-highlighted"
            >
              {{ data.avgDaysToFinish }}
              <span class="text-sm font-normal text-muted">days</span>
            </p>
          </div>
        </div>

        <!-- Yearly pages heatmap (full width) -->
        <StatsChartsYearlyHeatmap
          :year="data.pagesHeatmap.year"
          :days="data.pagesHeatmap.days"
          :available-years="availableYears"
          @update:year="heatmapYear = $event"
        />

        <!-- Two-column layout for the remaining charts -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <StatsChartsGenreDonut :data="data.genreDistribution" />
          <StatsChartsFinishedPerMonth :data="data.finishedPerMonth" />
          <StatsChartsReadingVelocity :data="data.readingVelocity" />
          <StatsChartsTopAuthors :data="data.topAuthors" />
          <StatsChartsDaysToFinishHistogram :data="data.daysToFinishBuckets" />
          <StatsChartsLibraryGrowth :data="data.libraryGrowth" />
        </div>
      </div>
    </template>
  </UDashboardPanel>
</template>
