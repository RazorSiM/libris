import { inject, type InjectionKey } from "vue";

export interface AppConfig {
  wsBaseUrl: string;
  docsUrl: string;
}

export const librisConfigKey: InjectionKey<AppConfig> = Symbol("libris:config");

export function useLibrisConfig(): AppConfig {
  const config = inject(librisConfigKey);
  if (!config) {
    throw new Error("useLibrisConfig() called before the app config was provided in main.ts");
  }
  return config;
}
