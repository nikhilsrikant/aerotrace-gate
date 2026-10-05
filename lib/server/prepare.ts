// Process start-up shared by every role: resolve NAME_REF secret references, check required settings, start telemetry.
import { resolveEnvRefs } from './cloud/secrets';
import { startTelemetry } from './otel';

export async function prepareProcess(role: string, required: string[]) {
  const resolved = await resolveEnvRefs();
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) throw new Error(`Missing required settings: ${missing.join(', ')} (set them, or NAME_REF pointing at your secret manager)`);
  if (required.includes('SESSION_SECRET') && (process.env.SESSION_SECRET ?? '').length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  await startTelemetry(role);
  if (resolved.length) process.stdout.write(JSON.stringify({ level: 'info', msg: 'resolved secret references', role, names: resolved }) + '\n');
  return resolved;
}
