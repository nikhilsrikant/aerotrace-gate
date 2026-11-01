// Telemetry hooks used across the app. A no-op until the server installs OpenTelemetry (lib/server/otel.ts),
// so the engine, the browser demo and the tests carry no tracing dependency.
export type Attrs = Record<string, string | number | boolean | undefined>;
export interface Telemetry {
  span<T>(name: string, attrs: Attrs, fn: (set: (a: Attrs) => void) => Promise<T>): Promise<T>;
  count(name: string, value?: number, attrs?: Attrs): void;
  record(name: string, value: number, attrs?: Attrs): void;
  /** Observable gauge, read at each metric export. */
  gauge(name: string, read: () => Promise<number> | number, description?: string): void;
}
const noop: Telemetry = { span: (_n, _a, fn) => fn(() => {}), count() {}, record() {}, gauge() {} };
// Held on globalThis: the boot script and the Next.js server bundle each have their own copy of this module.
const G = globalThis as { __aeroTelemetry?: Telemetry };
const impl = () => G.__aeroTelemetry ?? noop;
export const setTelemetry = (t: Telemetry) => { G.__aeroTelemetry = t; };
export const telemetry: Telemetry = {
  span: (n, a, fn) => impl().span(n, a, fn), count: (n, v, a) => impl().count(n, v, a), record: (n, v, a) => impl().record(n, v, a), gauge: (n, r, d) => impl().gauge(n, r, d),
};
