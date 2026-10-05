// Approval policy engine. Pure functions, no I/O: the same code decides authority on the server and in the browser demo.
// Who can approve is data the organisation edits, never code.
import type { ApprovalPolicy, PolicyStep, DecisionRecord, Delegation, PublicUser, RunRecord } from './model';
import type { DAL, Verdict } from '../engine/types';

export interface RunFacts { datasetId: string; module: string; dal: DAL; verdict: Verdict; requestedBy: string }

const glob = (pattern: string, value: string) => {
  const p = pattern.trim().toUpperCase(); if (!p) return false;
  if (!p.includes('*')) return p === value.toUpperCase();
  const re = new RegExp('^' + p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return re.test(value.toUpperCase());
};

export function policyMatches(p: ApprovalPolicy, f: RunFacts): boolean {
  if (!p.active || !p.steps.length) return false;
  const m = p.match;
  if (m.datasetIds.length && !m.datasetIds.includes(f.datasetId)) return false;
  if (m.modules.length && !m.modules.some(x => glob(x, f.module))) return false;
  if (m.dals.length && !m.dals.includes(f.dal)) return false;
  if (m.verdicts.length && !m.verdicts.includes(f.verdict)) return false;
  return true;
}

/** Highest priority wins; ties go to the most specific match, then the newest edit. */
export function selectPolicy(policies: ApprovalPolicy[], f: RunFacts): ApprovalPolicy | null {
  const spec = (p: ApprovalPolicy) => (p.match.datasetIds.length ? 1 : 0) + (p.match.modules.length ? 1 : 0) + (p.match.dals.length ? 1 : 0) + (p.match.verdicts.length ? 1 : 0);
  return policies.filter(p => policyMatches(p, f))
    .sort((a, b) => b.priority - a.priority || spec(b) - spec(a) || b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

export interface Directory { users: Map<string, PublicUser>; delegations: Delegation[] }
export interface StepState {
  step: PolicyStep; approvals: DecisionRecord[]; satisfied: boolean; open: boolean;
  eligible: { userId: string; name: string; via: 'direct' | 'delegation'; onBehalfOf?: string }[];
}
export interface ApprovalState {
  status: 'pending' | 'approved' | 'denied' | 'no_policy'; policy: ApprovalPolicy | null; steps: StepState[];
  denial?: DecisionRecord; waitingOn: string;
}

export function activeDelegations(d: Delegation[], at: Date): Delegation[] {
  const t = at.getTime();
  return d.filter(x => !x.revokedAt && Date.parse(x.startsAt) <= t && t < Date.parse(x.endsAt));
}

function directlyEligible(u: PublicUser, step: PolicyStep): boolean {
  return u.active && (step.userIds.includes(u.id) || u.groupIds.some(g => step.groupIds.includes(g)));
}

export function evaluateApproval(policy: ApprovalPolicy | null, run: Pick<RunRecord, 'requestedBy' | 'decisions'>, dir: Directory, at = new Date()): ApprovalState {
  if (!policy) return { status: 'no_policy', policy: null, steps: [], waitingOn: 'No approval policy covers this audit. An administrator has to add one.' };
  const decided = new Set<string>();
  run.decisions.forEach(d => { decided.add(d.userId); if (d.onBehalfOf) decided.add(d.onBehalfOf.id); });
  const denial = run.decisions.find(d => d.action === 'deny');
  const dels = activeDelegations(dir.delegations, at);
  let blocked = false;
  const steps: StepState[] = policy.steps.map(step => {
    const approvals = run.decisions.filter(d => d.stepId === step.id && d.action === 'approve');
    const satisfied = approvals.length >= Math.max(1, step.min);
    const open = !satisfied && !denial && !(policy.sequential && blocked);
    if (!satisfied) blocked = true;
    const eligible: StepState['eligible'] = [];
    if (open) {
      const ok = (id: string) => !decided.has(id) && (policy.allowSelfApproval || id !== run.requestedBy);
      for (const u of dir.users.values()) if (directlyEligible(u, step) && ok(u.id)) eligible.push({ userId: u.id, name: u.name, via: 'direct' });
      for (const d of dels) {
        const from = dir.users.get(d.fromUserId), to = dir.users.get(d.toUserId);
        if (!from || !to || !to.active || !directlyEligible(from, step) || !ok(from.id) || !ok(to.id)) continue;
        if (!eligible.some(e => e.userId === to.id)) eligible.push({ userId: to.id, name: to.name, via: 'delegation', onBehalfOf: from.id });
      }
    }
    return { step, approvals, satisfied, open, eligible };
  });
  if (denial) return { status: 'denied', policy, steps, denial, waitingOn: `Denied by ${denial.userName}` };
  if (steps.every(s => s.satisfied)) return { status: 'approved', policy, steps, waitingOn: 'Fully approved' };
  const next = steps.filter(s => s.open);
  const waitingOn = next.map(s => `${s.step.name} (${s.approvals.length}/${s.step.min})`).join(' and ');
  return { status: 'pending', policy, steps, waitingOn: `Waiting on ${waitingOn}` };
}

/** The step this user would sign if they clicked now, or why they can't. */
export function stepFor(state: ApprovalState, userId: string): { step: StepState; via: 'direct' | 'delegation'; onBehalfOf?: string } | { reason: string } {
  if (state.status === 'no_policy') return { reason: state.waitingOn };
  if (state.status !== 'pending') return { reason: state.status === 'approved' ? 'This audit is already fully approved.' : 'This audit was denied.' };
  const candidates = state.steps.filter(s => s.open).flatMap(s => s.eligible.filter(e => e.userId === userId).map(e => ({ step: s, via: e.via, onBehalfOf: e.onBehalfOf })));
  if (!candidates.length) return { reason: 'You are not an approver for the step this audit is waiting on.' };
  return candidates.sort((a, b) => (a.via === 'direct' ? 0 : 1) - (b.via === 'direct' ? 0 : 1))[0];
}
