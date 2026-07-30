import { z } from "zod";

export const isbn10Schema = z
  .string()
  .refine((v) => !v || /^\d{9}[\dX]$/.test(v), "Must be 10 characters (digits, last may be X)");

export const isbn13Schema = z.string().refine((v) => !v || /^\d{13}$/.test(v), "Must be 13 digits");

export const yearStringSchema = z
  .string()
  .refine(
    (v) => !v || (/^\d{4}$/.test(v) && Number(v) >= 1000 && Number(v) <= 2100),
    "Enter a valid year (1000-2100)",
  );

export const pageCountStringSchema = z
  .string()
  .refine(
    (v) => !v || (Number(v) > 0 && Number(v) < 100000 && Number.isInteger(Number(v))),
    "Enter a valid page count",
  );

export const coverUrlSchema = z
  .string()
  .refine((v) => !v || /^https?:\/\/.+/.test(v), "Must be a valid http(s) URL");
