import { formatTimeAgo as vueUseFormatTimeAgo, useDateFormat } from "@vueuse/core";

export function formatFileSize(bytes: number | string): string {
  const n = typeof bytes === "string" ? Number(bytes) : bytes;
  if (isNaN(n) || n < 0) return "—";
  if (n === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  const value = n / Math.pow(1024, i);
  return `${value.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatTimeAgo(date: string | number | null | undefined): string {
  if (date == null || date === "") return "";
  let ms: number;
  if (typeof date === "string") {
    ms = new Date(date).getTime();
  } else {
    ms = date < 1e10 ? date * 1000 : date;
  }
  if (isNaN(ms)) return "";
  return vueUseFormatTimeAgo(new Date(ms));
}

export function formatDate(
  date: string | number | Date | null | undefined,
  options: { includeTime?: boolean } = {},
): string {
  if (date == null || date === "") return "—";
  const d = date instanceof Date ? date : new Date(date as string | number);
  if (isNaN(d.getTime())) return "—";
  const fmt = options.includeTime ? "MMMM D, YYYY h:mm:ss A" : "MMMM D, YYYY";
  return useDateFormat(d, fmt, { locales: "en-US" }).value;
}
