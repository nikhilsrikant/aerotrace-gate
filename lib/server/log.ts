// Structured JSON logs on stdout, one line per event, for Splunk, ELK or CloudWatch.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
const min = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? 20;
export function log(level: Level, msg: string, extra: Record<string, unknown> = {}) {
  if (LEVELS[level] < min) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, service: process.env.AEROTRACE_ROLE || 'web', ...extra });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
}
