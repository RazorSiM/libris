---
"@libris/api-hono": minor
---

The API now exports traces, not only logs. `otel.ts` starts the `NodeSDK` with
`@opentelemetry/auto-instrumentations-node`, so a request produces spans for
the HTTP server (Hono rides on `node:http`), Postgres and Redis. `fs` and `dns`
instrumentation stay off — one span per syscall would bury the request path.
With an active span, the existing logger plugin adds `trace_id` and `span_id`
to each log record, so a trace backend can link a span to its log lines.

Behaviour is unchanged without `OTEL_EXPORTER_OTLP_ENDPOINT`: the SDK never
starts. Traces are also suppressed under `NODE_ENV=test`, as before.
