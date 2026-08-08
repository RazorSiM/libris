import { z } from "@hono/zod-openapi";

function isExternalHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

export const ExternalHttpUrlSchema = z
  .string()
  .max(2048)
  .refine(isExternalHttpUrl, "Cover URL must be an HTTP(S) URL without credentials")
  .nullable();

export function validateApprovedCoverUrl(
  fields: Record<string, { value: unknown }>,
  ctx: z.RefinementCtx,
): void {
  const cover = fields.coverUrl;
  if (!cover) return;
  if (!ExternalHttpUrlSchema.safeParse(cover.value).success) {
    ctx.addIssue({
      code: "custom",
      path: ["fields", "coverUrl", "value"],
      message: "Cover URL must be an HTTP(S) URL without credentials",
    });
  }
}
