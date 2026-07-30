import type { App } from "vue";
import { useToast } from "@nuxt/ui/composables";

export function setupErrorHandler(app: App) {
  app.config.errorHandler = (error: unknown) => {
    if (error instanceof Error && error.message) {
      console.error("[Unhandled error]", error);
      const toast = useToast();
      toast.add({
        title: "Something went wrong",
        description: error.message,
        color: "error",
      });
    }
  };
}
