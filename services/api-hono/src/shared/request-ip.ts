import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";
import type { AppVariables } from "../context.js";

type AppContext = Context<{ Variables: AppVariables }>;

function getConnectionIp(c: AppContext): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  } catch {
    return undefined;
  }
}

function getForwardedIp(c: AppContext): string | undefined {
  const realIp = c.req.header("x-real-ip")?.trim();
  if (realIp) return realIp;

  const forwardedFor = c.req.header("x-forwarded-for");
  return forwardedFor?.split(",")[0]?.trim() || undefined;
}

export function getRequestIp(c: AppContext): string {
  const env = c.get("env");

  if (env.TRUST_PROXY_HEADERS === "1") {
    return getForwardedIp(c) || getConnectionIp(c) || "unknown";
  }

  return getConnectionIp(c) || "unknown";
}
