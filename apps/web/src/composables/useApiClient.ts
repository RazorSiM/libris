import { hc } from "hono/client";
import type { AppType } from "@libris/api-hono/client";

export function useApiClient() {
  return hc<AppType>("", {
    init: {
      credentials: "include",
    },
    fetch: async (input: RequestInfo | URL, requestInit?: RequestInit) => {
      const res = await fetch(input, requestInit);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new ApiError(res.status, body);
      }
      return res;
    },
  });
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    let message = `API error ${status}`;
    try {
      const json = JSON.parse(body);
      if (json.error) message = json.error;
    } catch {
      if (body) message = body;
    }
    super(message);
    this.name = "ApiError";
  }
}
