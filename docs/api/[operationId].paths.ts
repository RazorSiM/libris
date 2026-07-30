import { usePaths } from "vitepress-openapi";
import { spec } from "../.vitepress/openapi";

export default {
  paths() {
    return usePaths({ spec })
      .getPathsByVerbs()
      .map(({ operationId, summary }: any) => ({
        params: {
          operationId,
          pageTitle: `${summary} - API Reference`,
        },
      }));
  },
};
