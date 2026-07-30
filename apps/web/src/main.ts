import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import { routes } from "vue-router/auto-routes";
import { DataLoaderPlugin } from "vue-router/experimental";
import { createHead } from "@unhead/vue/client";
import { createPinia } from "pinia";
import { PiniaColada } from "@pinia/colada";
import uiPlugin from "@nuxt/ui/vue-plugin";

import App from "./App.vue";
import { librisConfigKey, type AppConfig } from "./composables/useLibrisConfig";
import { setupServerEvents } from "./plugins/server-events";
import { setupErrorHandler } from "./plugins/error-handler";
import { installRouterGuards } from "./router/guards";

import "@fontsource-variable/merriweather";
import "./assets/css/main.css";

// vue-echarts: register the <VChart> component globally (nuxt-echarts did
// this automatically in the Nuxt app). Combined with the use(...) calls
// below, this mirrors the Nuxt module's side effects.
import VChart from "vue-echarts";
import { use } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";
import { BarChart, LineChart, PieChart, HeatmapChart } from "echarts/charts";
import {
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DatasetComponent,
  CalendarComponent,
  VisualMapComponent,
} from "echarts/components";

use([
  SVGRenderer,
  BarChart,
  LineChart,
  PieChart,
  HeatmapChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  DatasetComponent,
  CalendarComponent,
  VisualMapComponent,
]);

async function loadAppConfig(): Promise<AppConfig> {
  const base: AppConfig = {
    wsBaseUrl: import.meta.env.VITE_WS_BASE_URL ?? "",
    docsUrl: import.meta.env.VITE_DOCS_URL ?? "https://docs.libris.raz.wtf",
  };

  try {
    const res = await fetch("/config.json", { cache: "no-store" });
    if (!res.ok) return base;
    const overrides = (await res.json()) as Partial<AppConfig>;
    return { ...base, ...overrides };
  } catch {
    return base;
  }
}

async function bootstrap() {
  const appConfig = await loadAppConfig();

  const app = createApp(App);
  app.component("VChart", VChart);
  const head = createHead();
  const pinia = createPinia();

  const router = createRouter({
    history: createWebHistory(),
    routes,
  });
  installRouterGuards(router);

  app.provide(librisConfigKey, appConfig);
  app.use(pinia);
  app.use(PiniaColada, {});
  app.use(head);
  // DataLoaderPlugin MUST be registered before the router so navigation
  // guards attach before the initial resolve.
  app.use(DataLoaderPlugin, { router });
  app.use(router);
  app.use(uiPlugin);

  setupServerEvents(app, appConfig);
  setupErrorHandler(app);

  await router.isReady();
  app.mount("#app");
}

await bootstrap();
