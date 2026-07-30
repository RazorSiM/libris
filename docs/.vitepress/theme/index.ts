import { h, nextTick, watch } from "vue";
import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { useData } from "vitepress";
import { createMermaidRenderer } from "vitepress-mermaid-renderer";
import { theme, useOpenapi } from "vitepress-openapi/client";
import "vitepress-openapi/dist/style.css";

import { spec } from "../openapi";

export default {
  extends: DefaultTheme,
  Layout: () => {
    const { isDark } = useData();

    const initMermaid = () => {
      createMermaidRenderer({
        theme: isDark.value ? "dark" : "default",
      });
    };

    void nextTick(() => initMermaid());

    watch(
      () => isDark.value,
      () => initMermaid(),
    );

    return h(DefaultTheme.Layout);
  },
  enhanceApp(ctx) {
    useOpenapi({
      spec,
      config: {
        operation: {
          slots: [
            "header",
            "path",
            "description",
            "security",
            "parameters",
            "request-body",
            "responses",
            "code-samples",
            "footer",
          ],
        },
      },
    });
    theme.enhanceApp(ctx);
  },
} satisfies Theme;
