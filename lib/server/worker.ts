// Worker process: claims audit, import and evidence-sync jobs from Postgres, runs the scheduler, and exposes health and metrics.
// Run as many replicas as you like; SKIP LOCKED hands each job and each due schedule to exactly one of them.
import http from 'node:http';
import os from 'node:os';
import { ctx } from './context';
import { importBundle } from '../core/bundle';
import { log } from './log';
import { telemetry } from '../engine/telemetry';
import { flushTelemetry } from './otel';

const ID = `${os.hostname()}-${process.pid}`;
const CONCURRENCY = Math.max(1, Number(process.env.WORKER_CONCURRENCY || 2));
const POLL_MS = Number(process.env.WORKER_POLL_MS || 1000);
const SCHED_MS = Number(process.env.SCHEDULER_INTERVAL_MS || 30000);
const STALE_MS = Number(process.env.JOB_STALE_MS || 120000);
const m = { processed: 0, failed: 0, retried: 0, busy: 0, durationSum: 0, schedulesFired: 0, reaped: 0, lastTick: Date.now(), started: Date.now() };
let stopping = false;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function runOne(): Promise<boolean> {
  const { repo, svc } = await ctx();
  const job = await repo.claimJob(ID); if (!job) return false;
  m.busy++; const t0 = Date.now();
  const beat = setInterval(() => repo.heartbeatJob(job.id).catch(() => {}), 10000);
  log('info', 'job started', { job: job.id, kind: job.kind, attempt: job.attempts, worker: ID });
  let outcome = 'ok';
  try { await telemetry.span(`job ${job.kind}`, { 'aerotrace.job.id': job.id, 'aerotrace.job.kind': job.kind, 'aerotrace.job.attempt': job.attempts, 'aerotrace.run.id': job.payload.runId as string | undefined }, async () => {
  try {
    if (job.kind === 'audit') await svc.executeAudit(String(job.payload.runId), job.attempts, job.maxAttempts);
    else if (job.kind === 'import') {
      const id = String(job.payload.datasetId);
      const bytes = await repo.getBundle(id); if (!bytes) throw new Error('Uploaded bundle is missing');
      try { const { corpus, warnings } = await importBundle(bytes); await svc.completeImport(id, corpus, warnings); }
      catch (e) { await svc.failImport(id, (e as Error).message); }
    } else if (job.kind === 'sync') {
      await svc.executeSync(String(job.payload.sourceId), { scheduleId: job.payload.scheduleId as string | undefined, requestedBy: job.payload.requestedBy as string | undefined });
    }
    await repo.finishJob(job.id, true); m.processed++;
    log('info', 'job done', { job: job.id, kind: job.kind, ms: Date.now() - t0 });
  } catch (e) {
    const msg = (e as Error).message; const retryIn = 5000 * 2 ** (job.attempts - 1);
    await repo.finishJob(job.id, false, msg, job.attempts < job.maxAttempts ? retryIn : undefined);
    if (job.attempts < job.maxAttempts) m.retried++; else m.failed++;
    log('warn', 'job failed', { job: job.id, kind: job.kind, attempt: job.attempts, error: msg, retryInMs: job.attempts < job.maxAttempts ? retryIn : null });
    outcome = job.attempts < job.maxAttempts ? 'retry' : 'failed';
  } }); } finally {
    clearInterval(beat); m.busy--; m.durationSum += Date.now() - t0;
    telemetry.record('aerotrace.jobs.duration', Date.now() - t0, { kind: job.kind, outcome });
  }
  return true;
}

async function loop(n: number) {
  while (!stopping) {
    try { if (!(await runOne())) await sleep(POLL_MS); }
    catch (e) { log('error', 'worker loop error', { slot: n, error: String(e) }); await sleep(5000); }
  }
}

async function housekeeping() {
  while (!stopping) {
    try {
      const { repo, svc } = await ctx();
      const fired = await svc.tickSchedules(); m.schedulesFired += fired; if (fired) log('info', 'schedules fired', { count: fired });
      const reaped = await repo.reapStaleJobs(new Date(Date.now() - STALE_MS).toISOString());
      for (const j of reaped) { m.reaped++; log('warn', 'requeued a job whose worker stopped responding', { job: j.id, status: j.status }); if (j.kind === 'audit' && j.status === 'queued') await repo.updateRun(String(j.payload.runId), { status: 'queued' }); }
      m.lastTick = Date.now();
    } catch (e) { log('error', 'housekeeping error', { error: String(e) }); }
    for (let t = 0; t < SCHED_MS && !stopping; t += 500) await sleep(500);
  }
}

function serveMetrics() {
  const port = Number(process.env.WORKER_METRICS_PORT || 9464);
  const srv = http.createServer(async (req, res) => {
    if (req.url === '/healthz') { const ok = Date.now() - m.lastTick < SCHED_MS * 3 + 30000; res.writeHead(ok ? 200 : 503).end(ok ? 'ok' : 'scheduler stalled'); return; }
    if (req.url === '/metrics') {
      let q: Record<string, number> = {}; try { q = await (await ctx()).repo.queueStats(); } catch { /* db down shows as missing */ }
      const lines = [
        '# HELP aerotrace_worker_jobs_total Jobs finished by this worker', '# TYPE aerotrace_worker_jobs_total counter',
        `aerotrace_worker_jobs_total{result="ok"} ${m.processed}`, `aerotrace_worker_jobs_total{result="failed"} ${m.failed}`, `aerotrace_worker_jobs_total{result="retried"} ${m.retried}`,
        '# TYPE aerotrace_worker_busy gauge', `aerotrace_worker_busy ${m.busy}`, `aerotrace_worker_concurrency ${CONCURRENCY}`,
        '# TYPE aerotrace_worker_job_seconds_sum counter', `aerotrace_worker_job_seconds_sum ${(m.durationSum / 1000).toFixed(3)}`, `aerotrace_worker_job_seconds_count ${m.processed + m.failed + m.retried}`,
        `aerotrace_worker_schedules_fired_total ${m.schedulesFired}`, `aerotrace_worker_jobs_reaped_total ${m.reaped}`,
        '# HELP aerotrace_queue_jobs Jobs by status (last 7 days, plus all queued and running)', '# TYPE aerotrace_queue_jobs gauge',
        ...Object.entries(q).map(([k, v]) => `aerotrace_queue_jobs{status="${k}"} ${v}`),
      ];
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(lines.join('\n') + '\n'); return;
    }
    res.writeHead(404).end();
  });
  srv.listen(port, () => log('info', 'worker metrics listening', { port }));
  return srv;
}

export async function startWorker() {
  process.env.AEROTRACE_ROLE ||= 'worker';
  await (await ctx()).repo.ping();
  log('info', 'worker started', { worker: ID, concurrency: CONCURRENCY, schedulerIntervalMs: SCHED_MS });
  const srv = serveMetrics();
  // Gauges read at each metric export: queue depth and the approval backlog (the numbers the alerts watch).
  const { repo: r0 } = await ctx();
  telemetry.gauge('aerotrace.jobs.queued', async () => (await r0.queueStats()).queued ?? 0, 'Jobs waiting for a worker');
  telemetry.gauge('aerotrace.approvals.pending', async () => Number((await r0.pool.query("SELECT count(*) n FROM runs WHERE status='awaiting_approval'")).rows[0].n), 'Audits waiting for a decision');
  telemetry.gauge('aerotrace.approvals.oldest_age_seconds', async () => Number((await r0.pool.query("SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(created_at)), 0) a FROM runs WHERE status='awaiting_approval'")).rows[0].a), 'Age of the oldest audit waiting for a decision');
  const loops = [housekeeping(), ...Array.from({ length: CONCURRENCY }, (_, i) => loop(i))];
  const stop = async (sig: string) => {
    if (stopping) return; stopping = true; log('info', 'shutting down, finishing current jobs', { signal: sig, busy: m.busy });
    const deadline = Date.now() + Number(process.env.WORKER_SHUTDOWN_GRACE_MS || 30000);
    while (m.busy > 0 && Date.now() < deadline) await sleep(250);
    srv.close(); await flushTelemetry(); await (await ctx()).repo.pool.end().catch(() => {}); process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM')); process.on('SIGINT', () => void stop('SIGINT'));
  await Promise.all(loops);
}
