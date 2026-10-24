import { FastifyOtelInstrumentation } from '@fastify/otel';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';

/** service.namespace (incubating in semantic-conventions): Grafana Cloud makes the job label `<namespace>/<name>`. */
const ATTR_SERVICE_NAMESPACE = 'service.namespace';

// OpenTelemetry for the API (architecture §11.1, D-086): request metrics and traces (HTTP, Fastify routes, pg
// queries) to Alloy at OTEL_EXPORTER_OTLP_ENDPOINT, which forwards them to Grafana Cloud. Started from the app's
// instrument.js (node --import), before Fastify and pg load. Without the endpoint (tests, local runs) it's off.

export function startTracing(opts: { service: string; env: string; version: string }): NodeSDK | null {
  if (!process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) return null;
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: opts.service,
      [ATTR_SERVICE_VERSION]: opts.version,
      // So metrics are told apart by environment: job="prod/erp-api", job="staging/erp-api".
      [ATTR_SERVICE_NAMESPACE]: opts.env,
      'deployment.environment.name': opts.env,
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: 60_000 }),
    ],
    instrumentations: [
      // The container health check calls /api/health every 10 s: not worth a trace.
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => req.url === '/api/health' }),
      new FastifyOtelInstrumentation({ registerOnInitialization: true }),
      new PgInstrumentation(),
    ],
  });
  sdk.start();
  return sdk;
}
