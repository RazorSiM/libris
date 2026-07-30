/**
 * Resolves an ECharts theme object from the current color mode.
 *
 * Palette is derived from the Nuxt UI design tokens — at mount time we read
 * CSS custom properties off :root (--ui-primary, --ui-bg, --ui-text, etc.)
 * and feed them into the theme. This keeps the chart palette in lockstep
 * with any global color-token change (app theme swap, user accent change)
 * without the individual chart components needing to know any hex values.
 *
 * Falls back to a sensible hand-tuned palette if the vars are unresolvable
 * (e.g. during SSR or before hydration).
 */

type ChartTheme = {
  color: string[];
  backgroundColor: string;
  textStyle: { color: string };
  title: { textStyle: { color: string } };
  legend: { textStyle: { color: string } };
  tooltip: {
    backgroundColor: string;
    borderColor: string;
    textStyle: { color: string };
  };
  axisPointer: { lineStyle: { color: string } };
  categoryAxis: {
    axisLine: { lineStyle: { color: string } };
    axisLabel: { color: string };
    splitLine: { lineStyle: { color: string } };
  };
  valueAxis: {
    axisLine: { lineStyle: { color: string } };
    axisLabel: { color: string };
    splitLine: { lineStyle: { color: string } };
  };
  /**
   * Heatmap-specific palette. ECharts' built-in theme machinery can't express
   * the calendar + visualMap gradient because those are per-option settings,
   * not per-series. Chart components that use a calendar heatmap should read
   * these directly and feed them into their `option` builder.
   */
  heatmap: {
    /** Background color for days with no data — makes the grid visible. */
    emptyBg: string;
    /** Border color between individual day cells. */
    cellBorder: string;
    /** Two-stop gradient for visualMap.inRange.color: [low, high]. */
    gradient: [string, string];
  };
};

const FALLBACK_LIGHT: ChartTheme = {
  color: ["#00c16a", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4", "#f97316", "#14b8a6"],
  backgroundColor: "transparent",
  textStyle: { color: "#171717" },
  title: { textStyle: { color: "#171717" } },
  legend: { textStyle: { color: "#404040" } },
  tooltip: {
    backgroundColor: "#ffffff",
    borderColor: "#e5e5e5",
    textStyle: { color: "#171717" },
  },
  axisPointer: { lineStyle: { color: "#a3a3a3" } },
  categoryAxis: {
    axisLine: { lineStyle: { color: "#e5e5e5" } },
    axisLabel: { color: "#525252" },
    splitLine: { lineStyle: { color: "#f5f5f5" } },
  },
  valueAxis: {
    axisLine: { lineStyle: { color: "#e5e5e5" } },
    axisLabel: { color: "#525252" },
    splitLine: { lineStyle: { color: "#f5f5f5" } },
  },
  heatmap: {
    emptyBg: "#f3f4f6",
    cellBorder: "#ffffff",
    gradient: ["#dcfce7", "#00c16a"],
  },
};

const FALLBACK_DARK: ChartTheme = {
  color: ["#00dc82", "#60a5fa", "#fbbf24", "#f87171", "#a78bfa", "#22d3ee", "#fb923c", "#2dd4bf"],
  backgroundColor: "transparent",
  textStyle: { color: "#e5e5e5" },
  title: { textStyle: { color: "#f5f5f5" } },
  legend: { textStyle: { color: "#d4d4d4" } },
  tooltip: {
    backgroundColor: "#171717",
    borderColor: "#404040",
    textStyle: { color: "#f5f5f5" },
  },
  axisPointer: { lineStyle: { color: "#525252" } },
  categoryAxis: {
    axisLine: { lineStyle: { color: "#404040" } },
    axisLabel: { color: "#a3a3a3" },
    splitLine: { lineStyle: { color: "#262626" } },
  },
  valueAxis: {
    axisLine: { lineStyle: { color: "#404040" } },
    axisLabel: { color: "#a3a3a3" },
    splitLine: { lineStyle: { color: "#262626" } },
  },
  heatmap: {
    emptyBg: "#262626",
    cellBorder: "#0a0a0a",
    gradient: ["#14532d", "#00dc82"],
  },
};

function readVar(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  const v = styles.getPropertyValue(name).trim();
  return v || fallback;
}

function resolveFromDom(mode: "light" | "dark"): ChartTheme {
  if (typeof document === "undefined") return mode === "dark" ? FALLBACK_DARK : FALLBACK_LIGHT;
  const base = mode === "dark" ? FALLBACK_DARK : FALLBACK_LIGHT;
  const styles = getComputedStyle(document.documentElement);
  // Nuxt UI exposes --ui-primary / --ui-bg-elevated / --ui-text / --ui-text-muted /
  // --ui-border — read what's available, fall through to hand-tuned fallbacks.
  const primary = readVar(styles, "--ui-primary", base.color[0]!);
  return {
    ...base,
    color: [primary, ...base.color.slice(1)],
    textStyle: { color: readVar(styles, "--ui-text", base.textStyle.color) },
    title: {
      textStyle: { color: readVar(styles, "--ui-text-highlighted", base.title.textStyle.color) },
    },
    legend: {
      textStyle: { color: readVar(styles, "--ui-text-toned", base.legend.textStyle.color) },
    },
    tooltip: {
      backgroundColor: readVar(styles, "--ui-bg-elevated", base.tooltip.backgroundColor),
      borderColor: readVar(styles, "--ui-border", base.tooltip.borderColor),
      textStyle: { color: readVar(styles, "--ui-text", base.tooltip.textStyle.color) },
    },
    axisPointer: base.axisPointer,
    categoryAxis: {
      axisLine: {
        lineStyle: {
          color: readVar(styles, "--ui-border", base.categoryAxis.axisLine.lineStyle.color),
        },
      },
      axisLabel: { color: readVar(styles, "--ui-text-muted", base.categoryAxis.axisLabel.color) },
      splitLine: {
        lineStyle: {
          color: readVar(styles, "--ui-border-muted", base.categoryAxis.splitLine.lineStyle.color),
        },
      },
    },
    valueAxis: {
      axisLine: {
        lineStyle: {
          color: readVar(styles, "--ui-border", base.valueAxis.axisLine.lineStyle.color),
        },
      },
      axisLabel: { color: readVar(styles, "--ui-text-muted", base.valueAxis.axisLabel.color) },
      splitLine: {
        lineStyle: {
          color: readVar(styles, "--ui-border-muted", base.valueAxis.splitLine.lineStyle.color),
        },
      },
    },
  };
}

export function useChartTheme() {
  const colorMode = useColorMode();
  const theme = ref<ChartTheme>(colorMode.value === "dark" ? FALLBACK_DARK : FALLBACK_LIGHT);

  const refresh = () => {
    theme.value = resolveFromDom(colorMode.value === "dark" ? "dark" : "light");
  };

  onMounted(refresh);
  watch(() => colorMode.value, refresh);

  return theme;
}

export type { ChartTheme };
