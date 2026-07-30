import { useStorage } from "@vueuse/core";
import { watch } from "vue";

export type ThemeValue =
  | "default"
  | "ayu"
  | "catppuccin"
  | "dracula"
  | "gruvbox"
  | "material"
  | "nord"
  | "one"
  | "rose-pine"
  | "sepia"
  | "solarized"
  | "tokyo-night";

export const THEMES: { value: ThemeValue; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "ayu", label: "Ayu" },
  { value: "catppuccin", label: "Catppuccin" },
  { value: "dracula", label: "Dracula" },
  { value: "gruvbox", label: "Gruvbox" },
  { value: "material", label: "Material" },
  { value: "nord", label: "Nord" },
  { value: "one", label: "One" },
  { value: "rose-pine", label: "Rosé Pine" },
  { value: "sepia", label: "Sepia" },
  { value: "solarized", label: "Solarized" },
  { value: "tokyo-night", label: "Tokyo Night" },
];

const STORAGE_KEY = "libris-theme";

const theme = useStorage<ThemeValue>(STORAGE_KEY, "default");

if (typeof document !== "undefined") {
  const apply = (value: ThemeValue) => {
    if (value === "default") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", value);
    }
  };
  apply(theme.value);
  watch(theme, apply);
}

export function useTheme() {
  return { theme, themes: THEMES };
}
