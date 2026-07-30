import { NodeSDK } from "@opentelemetry/sdk-node";

let sdk: NodeSDK | undefined;

if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT && process.env.NODE_ENV !== "test") {
  process.env.OTEL_SERVICE_NAME ??= "libris";

  sdk = new NodeSDK();
  sdk.start();
}

export async function shutdownOtel(): Promise<void> {
  await sdk?.shutdown();
}
