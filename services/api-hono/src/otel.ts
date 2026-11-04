import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { NodeSDK } from "@opentelemetry/sdk-node";

let sdk: NodeSDK | undefined;

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.NODE_ENV !== "test") {
  process.env.OTEL_SERVICE_NAME ??= "libris";

  sdk = new NodeSDK({
    // Without instrumentations the SDK runs but exports no spans: the API only
    // ever produced logs. http (which sees Hono's requests through node:http),
    // pg and ioredis give the request path; fs and dns produce one span per
    // syscall and would bury it.
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
        "@opentelemetry/instrumentation-dns": { enabled: false },
      }),
    ],
  });
  sdk.start();
}

export async function shutdownOtel(): Promise<void> {
  await sdk?.shutdown();
}
