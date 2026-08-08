import { hc } from "hono/client";
import type { AppType } from "@libris/api-hono/client";
import { reportSessionInvalidated } from "~/lib/session-invalidation";

export function useApiClient() {
  return hc<AppType>("", {
    init: {
      credentials: "include",
    },
    fetch: async (input: RequestInfo | URL, requestInit?: RequestInit) => {
      const res = await fetch(input, requestInit);
      if (!res.ok) {
        // A 401 here is the server telling us the cookie is dead. Every query
        // in the app only runs while the store says we are signed in, so this
        // is never "you were never signed in" — it is the session going away
        // underneath us, and the app has to notice rather than toast.
        if (res.status === 401) reportSessionInvalidated();
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
