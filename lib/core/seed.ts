// First-run setup. Idempotent: does nothing once roles exist. Everything it creates is an editable example.
import type { Repo } from './repo';
import type { Role, Group, ApprovalPolicy, User } from './model';
import { ALL_PERMISSIONS, DEFAULT_SETTINGS, DEFAULT_WORKSPACE } from './model';
import type { Services } from './services';
import { randomId } from '../engine/crypto';

export interface SeedOptions {
  admin?: { email: string; name: string; password?: string | null };
  demoUsers?: boolean; syntheticDataset?: boolean; hash: (pw: string) => Promise<string>;
}
export const ids = { roleAdmin: 'role_admin', roleEngineer: 'role_engineer', roleAuditor: 'role_auditor', roleViewer: 'role_viewer',
  grpReviewers: 'grp_reviewers', grpQuality: 'grp_quality', grpDer: 'grp_der', grpAdmins: 'grp_admins' };

export async function seed(repo: Repo, svc: Services, o: SeedOptions): Promise<{ created: boolean; adminId?: string; datasetId?: string }> {
  if ((await repo.listRoles()).length) return { created: false };
  const now = new Date().toISOString();
  const roles: Role[] = [
    { id: ids.roleAdmin, name: 'Administrator', description: 'Everything, including who can approve what.', permissions: [...ALL_PERMISSIONS], builtIn: true, createdAt: now },
    { id: ids.roleEngineer, name: 'Engineer', description: 'Starts audits and reads reports. Approving comes from policies, not this role.', permissions: ['audit.view', 'audit.request'], builtIn: true, createdAt: now },
    { id: ids.roleAuditor, name: 'Auditor', description: 'Reads reports and the audit log.', permissions: ['audit.view', 'auditlog.view'], builtIn: true, createdAt: now },
    { id: ids.roleViewer, name: 'Viewer', description: 'Reads reports.', permissions: ['audit.view'], builtIn: true, createdAt: now },
  ];
  for (const r of roles) await repo.createRole(r);
  const groups: Group[] = [
    { id: ids.grpAdmins, name: 'Gate administrators', description: 'Run the platform.', oidcName: 'aerotrace-admins', roleIds: [ids.roleAdmin], createdAt: now },
    { id: ids.grpReviewers, name: 'Software reviewers', description: 'Sign off routine audits.', oidcName: 'aerotrace-reviewers', roleIds: [ids.roleEngineer], createdAt: now },
    { id: ids.grpQuality, name: 'Software Quality', description: 'SQA sign-off for DAL A and B.', oidcName: 'aerotrace-sqa', roleIds: [ids.roleEngineer], createdAt: now },
    { id: ids.grpDer, name: 'Certification (DER)', description: 'Final sign-off before an SOI audit.', oidcName: 'aerotrace-der', roleIds: [ids.roleAuditor], createdAt: now },
  ];
  if (!(await repo.listWorkspaces()).some(w => w.id === DEFAULT_WORKSPACE)) await repo.createWorkspace({ id: DEFAULT_WORKSPACE, name: DEFAULT_SETTINGS.orgName, slug: 'default', createdAt: now, createdBy: 'setup' });
  for (const g of groups) await repo.createGroup(g);
  const pol = (p: Partial<ApprovalPolicy> & Pick<ApprovalPolicy, 'id' | 'name' | 'priority' | 'steps'>): ApprovalPolicy => ({
    description: '', active: true, match: { datasetIds: [], modules: [], dals: [], verdicts: [] }, sequential: true, allowSelfApproval: false,
    denyRequiresReason: false, version: 1, updatedAt: now, updatedBy: 'Setup', ...p });
  for (const p of [
    pol({ id: 'pol_default', name: 'Default sign-off', priority: 0, description: 'Anything no other policy covers: one software reviewer.',
      steps: [{ id: 'step_rev', name: 'Software reviewer', groupIds: [ids.grpReviewers], userIds: [], min: 1 }] }),
    pol({ id: 'pol_dal_ab', name: 'DAL A and B: SQA then DER', priority: 20, description: 'Safety-critical software needs Quality and Certification, in that order.',
      match: { datasetIds: [], modules: [], dals: ['A', 'B'], verdicts: [] }, denyRequiresReason: true,
      steps: [{ id: 'step_sqa', name: 'Software Quality', groupIds: [ids.grpQuality], userIds: [], min: 1 }, { id: 'step_der', name: 'Certification (DER)', groupIds: [ids.grpDer], userIds: [], min: 1 }] }),
    pol({ id: 'pol_clean', name: 'Clean low-DAL results', priority: 10, description: 'A YES on DAL C or D needs one reviewer.',
      match: { datasetIds: [], modules: [], dals: ['C', 'D'], verdicts: ['YES'] },
      steps: [{ id: 'step_any', name: 'Software reviewer', groupIds: [ids.grpReviewers, ids.grpQuality], userIds: [], min: 1 }] }),
  ]) await repo.createPolicy(p);
  await repo.putSettings({ ...DEFAULT_SETTINGS });

  let adminId: string | undefined;
  if (o.admin) {
    const u: User = { id: randomId('usr'), email: o.admin.email.toLowerCase(), name: o.admin.name, active: true, provider: 'local',
      passwordHash: o.admin.password ? await o.hash(o.admin.password) : null, roleIds: [ids.roleAdmin], groupIds: [ids.grpAdmins], createdAt: now, mustChangePassword: !!o.admin.password, allowPasswordEnrollment: true,
      workspaceRoles: { [DEFAULT_WORKSPACE]: [ids.roleAdmin] }, platformAdmin: true };
    await repo.createUser(u); adminId = u.id;
  }
  if (o.demoUsers) {
    const mk = async (id: string, name: string, email: string, roleIds: string[], groupIds: string[]) =>
      repo.createUser({ id, email, name, active: true, provider: 'local', passwordHash: await o.hash('demo-password-1'), roleIds, groupIds, createdAt: now });
    await mk('usr_sam', 'Sam Patel', 'sam.patel@example.com', [ids.roleAdmin], [ids.grpAdmins]);
    await mk('usr_marcus', 'Marcus Lee', 'marcus.lee@example.com', [ids.roleEngineer], []);
    await mk('usr_priya', 'Priya Raman', 'priya.raman@example.com', [], [ids.grpQuality, ids.grpReviewers]);
    await mk('usr_dana', 'Dana Ortiz', 'dana.ortiz@example.com', [], [ids.grpDer]);
    await mk('usr_lee', 'Jordan Lee', 'jordan.lee@example.com', [ids.roleViewer], []);
  }
  await repo.appendAudit({ actorId: 'system', actorName: 'System', action: 'system.seeded', target: 'setup', details: { roles: roles.length, groups: groups.length, policies: 3, admin: o.admin?.email ?? null, demoUsers: !!o.demoUsers } });
  let datasetId: string | undefined;
  if (o.syntheticDataset) datasetId = (await svc.createSyntheticDataset(null, 'ALT-ALERT FMS (synthetic demo)', 178)).id;
  return { created: true, adminId, datasetId };
}
