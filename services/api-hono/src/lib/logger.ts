import { LogLayer, StructuredTransport } from "loglayer";
import { PinoTransport } from "@loglayer/transport-pino";
import { OpenTelemetryTransport } from "@loglayer/transport-opentelemetry";
import { openTelemetryPlugin } from "@loglayer/plugin-opentelemetry";
import { serializeError } from "serialize-error";
import pino from "pino";

const isTest = process.env.NODE_ENV === "test" || process.env.E2E_TEST === "1";
const isDev = process.env.NODE_ENV === "development";

// Dynamic import avoids bundling better-sqlite3 (pretty-terminal dep) into production
async function buildTransports() {
  if (isTest) return [new StructuredTransport({ logger: console, enabled: false })];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- LogLayer transport union types
  const out: any[] = [];

  if (isDev) {
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
  plugins: isTest ? [] : [openTelemetryPlugin()],
});

export function getLogger(tag: string) {
  return root.child().withContext({ component: tag });
}
