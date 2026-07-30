import type { ComposeOption } from "echarts/core";
import type {
  BarSeriesOption,
  HeatmapSeriesOption,
  LineSeriesOption,
  PieSeriesOption,
} from "echarts/charts";
import type {
  CalendarComponentOption,
  DatasetComponentOption,
  GridComponentOption,
  LegendComponentOption,
  TitleComponentOption,
  TooltipComponentOption,
  VisualMapComponentOption,
} from "echarts/components";

/**
 * Union of echarts option types in use across the app. Kept in sync with the
 * `use([...])` call in main.ts — if a new series/component is registered, add
 * its Option type here so `computed<ECOption>()` in charts stays typechecked.
 */
export type ECOption = ComposeOption<
  | BarSeriesOption
  | LineSeriesOption
  | PieSeriesOption
  | HeatmapSeriesOption
  | TitleComponentOption
  | TooltipComponentOption
  | LegendComponentOption
  | GridComponentOption
  | DatasetComponentOption
  | CalendarComponentOption
  | VisualMapComponentOption
>;
