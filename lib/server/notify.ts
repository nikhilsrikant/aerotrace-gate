// Slack, Microsoft Teams and generic JSON webhooks. Fire-and-forget with a short timeout; failures are logged, never block a decision.
import type { Settings, RunRecord } from '../core/model';
import { log } from './log';

const label: Record<string, string> = { 'run.awaiting_approval': 'is waiting for approval', 'run.approved': 'was approved', 'run.denied': 'was denied', 'run.failed': 'failed' };
export async function notify(s: Settings, event: string, payload: Record<string, unknown>) {
  const run = payload.run as RunRecord | undefined; if (!run) return;
  const base = process.env.PUBLIC_URL?.replace(/\/$/, '') || '';
  const link = base ? `${base}/#${run.id}` : run.id;
  const who = payload.by ? ` by ${payload.by}` : '';
  const extra = event === 'run.awaiting_approval' ? ` ${payload.waitingOn ?? ''}.` : payload.reason ? ` Reason: ${payload.reason}.` : event === 'run.failed' ? ` ${payload.error}` : '';
  const text = `AeroTrace: ${run.module} (DAL ${run.dal}) ${label[event] ?? event}${who}. Verdict ${payload.verdict ?? run.verdict ?? 'n/a'}.${extra} ${link}`;
  const post = async (url: string, body: unknown) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!res.ok) log('warn', 'webhook rejected', { event, status: res.status, host: new URL(url).host });
  };
  const jobs: Promise<void>[] = [];
  if (s.notifications.slackUrl) jobs.push(post(s.notifications.slackUrl, { text }));
  if (s.notifications.teamsUrl) jobs.push(post(s.notifications.teamsUrl, { '@type': 'MessageCard', '@context': 'https://schema.org/extensions', summary: text, text }));
  if (s.notifications.webhookUrl) jobs.push(post(s.notifications.webhookUrl, { event, runId: run.id, module: run.module, dal: run.dal, verdict: payload.verdict ?? run.verdict, status: run.status, link, at: new Date().toISOString(), ...(payload.approvers ? { approvers: payload.approvers } : {}) }));
  await Promise.allSettled(jobs);
}
