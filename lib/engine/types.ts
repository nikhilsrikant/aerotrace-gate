// Shared types for the AeroTrace audit engine. Pure TypeScript, runs in Node and the browser.

export type DAL = 'A' | 'B' | 'C' | 'D';
export type AgentName = 'Requirements' | 'Design' | 'Code' | 'Testing' | 'ConfigMgmt';
export const AGENTS: AgentName[] = ['Requirements', 'Design', 'Code', 'Testing', 'ConfigMgmt'];
export const AGENT_LABEL: Record<AgentName | 'Orchestrator', string> = {
  Requirements: 'Requirements', Design: 'Design', Code: 'Code', Testing: 'Testing',
  ConfigMgmt: 'Config Mgmt', Orchestrator: 'Orchestrator',
};

export interface Module { id: string; name: string; dal: DAL; files: string[] }
export interface HLR { id: string; module: string; text: string }
export interface LLR { id: string; module: string; hlr: string; text: string }
export interface DesignRecord { id: string; module: string; couplings: string[]; text: string }
export interface Fn {
  id: string; module: string; file: string; start: number; end: number;
  llrs: string[]; calls: string[]; entry: boolean; code: string;
}
export interface TestCase { id: string; module: string; llrs: string[]; fn: string; text: string }
export interface TestResult { test: string; status: 'PASS' | 'FAIL'; baseline: string; run: string }
export interface Coverage { fn: string; stmt: number; dec: number; mcdc: number }
export interface ProblemReport { id: string; module: string; sev: 1 | 2 | 3; status: 'OPEN' | 'CLOSED'; files: string[]; title: string }
export interface CMRecord { file: string; module: string; baselineSha: string; actualSha: string }
export interface PlanSection { id: string; title: string; text: string }

export interface Corpus {
  program: string; baseline: string; seed: number;
  modules: Module[]; hlrs: HLR[]; llrs: LLR[]; design: DesignRecord[]; fns: Fn[];
  tests: TestCase[]; results: TestResult[]; coverage: Coverage[]; prs: ProblemReport[];
  cm: CMRecord[]; plans: PlanSection[];
  truth: PlantedDefect[];
  counts: Record<string, number>; total: number; generatedMs: number;
}

export type DefectKind =
  | 'HLR_NO_LLR' | 'LLR_ORPHAN' | 'LLR_NO_TEST' | 'FN_NO_LLR' | 'FN_BAD_TAG' | 'DEAD_CODE'
  | 'TEST_FAIL' | 'TEST_NO_RESULT' | 'COVERAGE_GAP' | 'COUPLING_UNDOC' | 'CHECKSUM_MISMATCH'
  | 'OPEN_PR' | 'REQ_AMBIGUOUS' | 'CODE_REQ_MISMATCH' | 'ISR_FALSE_DEAD';
export interface PlantedDefect { kind: DefectKind; module: string; ref: string }

export type Severity = 1 | 2 | 3;
export type Layer = 'L1' | 'L2';
export interface Citation { kind: string; id: string; path: string; quote?: string }
export interface Finding {
  id: string; layer: Layer; agent: AgentName; rule: string; kind: DefectKind | 'OTHER';
  severity: Severity; objective: string; title: string; detail: string;
  module: string; ref: string; citations: Citation[];
  status: 'confirmed' | 'disputed' | 'rejected';
  dispute?: string; owner: string; blocks?: AgentName[];
}

export type MsgType = 'request' | 'status' | 'dependency' | 'blocker' | 'finding' | 'heartbeat' | 'result' | 'error';
export interface A2AMessage {
  id: string; ts: number; from: AgentName | 'Orchestrator'; to: AgentName | 'Orchestrator' | '*';
  subject: string; type: MsgType; correlationId: string; payload: Record<string, unknown>;
  sig: string; prevHash: string; hash: string; accepted: boolean; reason?: string; latencyMs?: number;
}

export interface AgentHealth {
  agent: AgentName | 'Orchestrator'; state: 'healthy' | 'degraded' | 'offline';
  attempts: number; retries: number; failures: number; breaker: 'closed' | 'open' | 'half-open';
  p95Ms: number; lastHeartbeat: number; messages: number;
}

export type Fault = 'none' | 'flaky' | 'offline' | 'malformed';
export interface AuditOptions {
  module: string; layer2: 'auto' | 'llm' | 'heuristic';
  faults?: Partial<Record<AgentName, Fault>>; requestedBy?: string;
}

export type Verdict = 'YES' | 'NO' | 'CONDITIONAL';
export interface CriticalStep { agent: AgentName | 'Orchestrator'; finding: string; title: string }
export interface NextAction { action: string; owner: string; count: number; onCriticalPath: boolean; severity: Severity }

export interface Decision {
  action: 'approve' | 'deny'; by: string; at: string; reason?: string; reportHash: string; signature: string;
}

export interface AuditRun {
  id: string; createdAt: string; finishedAt: string; durationMs: number;
  program: string; baseline: string; module: string; moduleName: string; dal: DAL;
  options: AuditOptions; layer2Mode: 'llm' | 'heuristic';
  verdict: Verdict; verdictReason: string; complete: boolean;
  findings: Finding[]; criticalPath: CriticalStep[]; nextActions: NextAction[];
  health: AgentHealth[]; messages: A2AMessage[]; chainValid: boolean;
  stats: {
    recordsScanned: number; l1: number; l2: number; disputed: number; rejected: number;
    bySeverity: Record<string, number>; recall: number; planted: number; caught: number;
    llmCalls: number; messages: number; rejectedMessages: number;
  };
  reportHash: string;
  status: 'awaiting_approval' | 'approved' | 'denied';
  decision?: Decision;
}

export type RunSummary = Pick<AuditRun, 'id' | 'createdAt' | 'module' | 'moduleName' | 'dal' | 'verdict' | 'verdictReason' | 'status' | 'complete' | 'layer2Mode' | 'reportHash' | 'durationMs'> & {
  counts: { l1: number; l2: number; disputed: number; s1: number; s2: number; s3: number };
  top: { severity: Severity; title: string; agent: AgentName }[];
  decision?: Decision; requestedBy?: string;
};

export type AuditEvent =
  | { kind: 'message'; message: A2AMessage }
  | { kind: 'phase'; text: string }
  | { kind: 'health'; health: AgentHealth[] };

export interface LLMClient {
  available: boolean;
  complete(system: string, user: string): Promise<string>;
}
