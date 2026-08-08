import { LogLayer, StructuredTransport } from "loglayer";
import { PinoTransport } from "@loglayer/transport-pino";
import { OpenTelemetryTransport } from "@loglayer/transport-opentelemetry";
import { openTelemetryPlugin } from "@loglayer/plugin-opentelemetry";
import { serializeError } from "serialize-error";
import pino from "pino";

/**
 * Which primary transport a given environment gets.
 *
 * - `silent` — unit tests (`NODE_ENV=test`). Vitest output stays readable.
 * - `pretty` — an interactive dev terminal. Costs a `better-sqlite3` import.
 * - `pino`   — everything else, including E2E. Machine-readable NDJSON.
 *
 * Exported for the unit test: the real selection happens at module load from
 * `process.env`, which a test cannot re-run without re-importing the module.
 *
 * `E2E_TEST=1` used to select `silent`, so the entire API
 * process emitted nothing in the two modes CI and Docker use — no access log,
 * no "Auth failure from <ip>", no worker or job:failed detail. Every
 * auth-failure diagnostic this branch added was invisible in the only
 * environment that exercises it. The original motivation was to keep the dev
 * branch from importing `better-sqlite3` in the E2E container; the answer to
 * that is the pino branch, not silence.
 */
export function resolveTransportMode(env: {
  NODE_ENV?: string;
  E2E_TEST?: string;
}): "silent" | "pretty" | "pino" {
  if (env.NODE_ENV === "test") return "silent";
  if (env.NODE_ENV === "development" && env.E2E_TEST !== "1") return "pretty";
  return "pino";
}

const mode = resolveTransportMode(process.env);

// Dynamic import avoids bundling better-sqlite3 (pretty-terminal dep) into
// production — and, since the E2E harness runs NODE_ENV=development, out of the
// E2E container too.
async function buildTransports() {
  if (mode === "silent") return [new StructuredTransport({ logger: console, enabled: false })];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LogLayer transport union types
  const out: any[] = [];

  if (mode === "pretty") {
    const [{ getPrettyTerminal, moonlight }, { default: Database }] = await Promise.all([
      import("@loglayer/transport-pretty-terminal"),
      import("better-sqlite3"),
    ]);
    out.push(getPrettyTerminal({ theme: moonlight, database: new Database(":memory:") }));
  } else {
    out.push(new PinoTransport({ logger: pino({ level: process.env.LOG_LEVEL ?? "info" }) }));
  }

  // Always included — noop when no OTel SDK is configured
  out.push(
    new OpenTelemetryTransport({
      onError: (err) => console.error("[otel-transport]", err),
    }),
  );

  return out;
}

export const root = new LogLayer({
  errorSerializer: serializeError,
  transport: await buildTransports(),
  plugins: mode === "silent" ? [] : [openTelemetryPlugin()],
});

export function getLogger(tag: string) {
  return root.child().withContext({ component: tag });
}
