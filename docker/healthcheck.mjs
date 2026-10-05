// Container health for either role: the web server answers /api/health, a worker answers /healthz on its metrics port.
const ok = url => fetch(url, { signal: AbortSignal.timeout(4000) }).then(r => r.ok, () => null);
const web = await ok(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`);
if (web !== null) process.exit(web ? 0 : 1);
const worker = await ok(`http://127.0.0.1:${process.env.WORKER_METRICS_PORT || 9464}/healthz`);
process.exit(worker ? 0 : 1);
