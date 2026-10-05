// OpenTelemetry for the web and worker processes: traces and metrics over OTLP/HTTP to a collector sidecar,
// which forwards to CloudWatch/X-Ray, Azure Monitor or Google Cloud Operations (deploy/otel/).
// Explicit spans and metrics rather than auto-instrumentation, so it also works inside the bundled worker.
import { trace, context, metrics, SpanStatusCode, type Histogram, type Counter } from '@opentelemetry/api';
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { setTelemetry, type Attrs } from '../engine/telemetry';

let started = false;
const clean = (a: Attrs = {}) => Object.fromEntries(Object.entries(a).filter(([, v]) => v !== undefined)) as Record<string, string | number | boolean>;

export async function startTelemetry(role: string): Promise<boolean> {
  if (started || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_SDK_DISABLED === 'true') return false;
  started = true;
  const extra = Object.fromEntries((process.env.OTEL_RESOURCE_ATTRIBUTES || '').split(',').map(kv => kv.split('=').map(s => s.trim())).filter(kv => kv.length === 2 && kv[0]));
  const resource = resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME || `aerotrace-${role}`, 'service.version': process.env.AEROTRACE_VERSION || 'dev', 'service.namespace': 'aerotrace', 'aerotrace.role': role, ...extra });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const tp = new BasicTracerProvider({ resource, spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter(), { scheduledDelayMillis: Number(process.env.OTEL_BSP_SCHEDULE_DELAY || 2000) })] });
  trace.setGlobalTracerProvider(tp);
  const mp = new MeterProvider({ resource, readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL || 15000) })] });
  metrics.setGlobalMeterProvider(mp);
  const tracer = trace.getTracer('aerotrace'); const meter = metrics.getMeter('aerotrace');
  const hist = new Map<string, Histogram>(); const ctr = new Map<string, Counter>();
  const unit = (n: string) => (n.endsWith('.duration') ? 'ms' : n.endsWith('seconds') ? 's' : '1');
  setTelemetry({
    span: (name, attrs, fn) => tracer.startActiveSpan(name, { attributes: clean(attrs) }, async span => {
      try { const out = await fn(a => span.setAttributes(clean(a))); span.setStatus({ code: SpanStatusCode.OK }); return out; }
      catch (e) { span.recordException(e as Error); span.setStatus({ code: SpanStatusCode.ERROR, message: (e as Error).message }); throw e; }
      finally { span.end(); }
    }),
    count(name, value = 1, attrs) { let c = ctr.get(name); if (!c) { c = meter.createCounter(name, { unit: '1' }); ctr.set(name, c); } c.add(value, clean(attrs)); },
    record(name, value, attrs) { let h = hist.get(name); if (!h) { h = meter.createHistogram(name, { unit: unit(name) }); hist.set(name, h); } h.record(value, clean(attrs)); },
    gauge(name, read, description) { meter.createObservableGauge(name, { description, unit: unit(name) }).addCallback(async r => { try { r.observe(await read()); } catch { /* skip this sample */ } }); },
  });
  const flush = async () => { await Promise.allSettled([tp.forceFlush(), mp.forceFlush()]); };
  process.once('SIGTERM', () => { void flush(); });
  (globalThis as { __aeroOtelFlush?: () => Promise<void> }).__aeroOtelFlush = flush;
  return true;
}
export async function flushTelemetry() { await (globalThis as { __aeroOtelFlush?: () => Promise<void> }).__aeroOtelFlush?.(); }
