'use client';
import { useState } from 'react';
import { useApp, useLoad, useAction, Head, Loading, ErrorBox, Field, Checks, Drawer, Confirm, when } from '../kit';
import type { PublicUser, Group, Role, Permission } from '../../lib/core/model';
import type { InviteLink } from '../api';

export function Access() {
  const [tab, setTab] = useState<'users' | 'groups' | 'roles'>('users');
  return <>
    <Head title="Users, groups and roles">Roles grant permissions such as starting audits or editing policies. Groups bundle people, can carry roles, and can map to a group in your identity provider so membership follows SSO. Who approves what is set in approval policies, using these groups.</Head>
    <div className="tabs" role="tablist">
      <button role="tab" aria-selected={tab === 'users'} onClick={() => setTab('users')}>Users</button>
      <button role="tab" aria-selected={tab === 'groups'} onClick={() => setTab('groups')}>Groups</button>
      <button role="tab" aria-selected={tab === 'roles'} onClick={() => setTab('roles')}>Roles</button>
    </div>
    {tab === 'users' ? <Users /> : tab === 'groups' ? <Groups /> : <Roles />}
  </>;
}

function Users() {
  const { api, refreshDir, me } = useApp();
  const users = useLoad(() => api.users(), []); const groups = useLoad(() => api.groups(), []); const roles = useLoad(() => api.roles(), []);
  const [edit, setEdit] = useState<(Partial<PublicUser> & { password?: string }) | null>(null);
  const [invite, setInvite] = useState<InviteLink | null>(null);
  const { busy, run } = useAction();
  if (users.error) return <ErrorBox error={users.error} />;
  if (!users.data || !groups.data || !roles.data) return <Loading />;
  const rn = (id: string) => roles.data!.roles.find(r => r.id === id)?.name; const gn = (id: string) => groups.data!.find(g => g.id === id)?.name;
  const save = () => run('save', async () => {
    if (edit!.id) await api.updateUser(edit!.id, { name: edit!.name, active: edit!.active, roleIds: edit!.roleIds, groupIds: edit!.groupIds, password: edit!.password || undefined });
    else { const u = await api.createUser({ email: edit!.email!, name: edit!.name!, password: edit!.password || undefined, roleIds: edit!.roleIds ?? [], groupIds: edit!.groupIds ?? [] }); setInvite(await api.createInvite(u.id)); }
    setEdit(null); await users.reload(); await refreshDir();
  }, 'Saved.');
  return <>
    <div className="row"><button className="btn primary" onClick={() => setEdit({ name: '', email: '', roleIds: ['role_engineer'], groupIds: [], active: true })}>Add user</button><span className="dim sm">SSO users appear here on first sign-in.</span></div>
    <div className="tbl"><table><thead><tr><th>Name</th><th>Sign-in</th><th>Passkeys</th><th>Roles</th><th>Groups</th><th>Status</th><th>Last sign-in</th><th /></tr></thead><tbody>
      {users.data.map(u => <tr key={u.id}><td><b style={{ fontWeight: 600 }}>{u.name}</b><div className="dim sm">{u.email}</div></td><td>{u.provider === 'oidc' ? 'SSO' : 'Password'}</td><td>{u.passkeys ? <span className="pill ok">{u.passkeys}</span> : <span className="pill warn" title="Will be asked to create one at next sign-in">none yet</span>}</td>
        <td className="sm">{u.roleIds.map(rn).filter(Boolean).join(', ') || '–'}</td><td className="sm">{u.groupIds.map(gn).filter(Boolean).join(', ') || '–'}</td>
        <td>{u.active ? <span className="pill ok">Active</span> : <span className="pill">Disabled</span>}</td><td className="sm">{when(u.lastLoginAt)}</td>
        <td><div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}><button className="btn sm" onClick={() => setEdit({ ...u })}>Edit</button>
          {!!u.passkeys && u.id !== me.user.id && <Confirm text={`Reset ${u.name}'s passkeys? They are signed out everywhere and get a new invite link to set up a passkey. Use this for a lost or replaced device.`} danger onYes={() => run('pk' + u.id, async () => { const r = await api.resetPasskeys(u.id); setInvite(r.invite); await users.reload(); return r; }, `Passkeys reset for ${u.name}.`)}><button className="btn sm ghost">Reset passkeys</button></Confirm>}
          {!u.passkeys && u.active && <button className="btn sm" disabled={busy === 'inv' + u.id} onClick={() => run('inv' + u.id, async () => setInvite(await api.createInvite(u.id)))}>Invite link</button>}</div></td></tr>)}
    </tbody></table></div>
    {invite && <InviteDialog link={invite} onClose={() => setInvite(null)} />}
    {edit && <Drawer title={edit.id ? `Edit ${edit.name}` : 'Add user'} onClose={() => setEdit(null)} footer={<><button className="btn primary" disabled={busy === 'save'} onClick={save}>Save</button><button className="btn" onClick={() => setEdit(null)}>Cancel</button></>}>
      <Field label="Name" id="u-n"><input id="u-n" value={edit.name ?? ''} onChange={e => setEdit({ ...edit, name: e.target.value })} /></Field>
      {!edit.id && <Field label="Email" id="u-e"><input id="u-e" type="email" value={edit.email ?? ''} onChange={e => setEdit({ ...edit, email: e.target.value })} /></Field>}
      {(!edit.id || edit.provider === 'local') && <Field label={edit.id ? 'Set a temporary password' : 'Password (optional)'} id="u-p" hint="Optional. New people get a one-time invite link to set up their passkey; a password is only a fallback sign-in and must be changed at first use."><input id="u-p" type="password" autoComplete="new-password" value={edit.password ?? ''} onChange={e => setEdit({ ...edit, password: e.target.value })} /></Field>}
      {edit.id && <label className="check"><input type="checkbox" checked={!!edit.active} onChange={e => setEdit({ ...edit, active: e.target.checked })} />Active (disabling signs them out everywhere)</label>}
      <Checks label="Roles" options={roles.data.roles.map(r => ({ id: r.id, label: r.name, hint: r.description }))} value={edit.roleIds ?? []} onChange={v => setEdit({ ...edit, roleIds: v })} />
      <Checks label="Groups" options={groups.data.map(g => ({ id: g.id, label: g.name, hint: g.oidcName ? `(SSO: ${g.oidcName})` : '' }))} value={edit.groupIds ?? []} onChange={v => setEdit({ ...edit, groupIds: v })} />
    </Drawer>}
  </>;
}

function Groups() {
  const { api, refreshDir, dir } = useApp();
  const groups = useLoad(() => api.groups(), []); const roles = useLoad(() => api.roles(), []); const users = useLoad(() => api.users(), []);
  const [edit, setEdit] = useState<(Partial<Group> & { members: string[] }) | null>(null);
  const { busy, run } = useAction();
  if (groups.error) return <ErrorBox error={groups.error} />;
  if (!groups.data || !roles.data || !users.data) return <Loading />;
  const members = (gid: string) => users.data!.filter(u => u.groupIds.includes(gid));
  return <>
    <div className="row"><button className="btn primary" onClick={() => setEdit({ name: '', description: '', oidcName: '', roleIds: [], members: [] })}>Add group</button></div>
    <div className="tbl"><table><thead><tr><th>Group</th><th>SSO group</th><th>Roles it grants</th><th>Members</th><th /></tr></thead><tbody>
      {groups.data.map(g => <tr key={g.id}><td><b style={{ fontWeight: 600 }}>{g.name}</b><div className="dim sm">{g.description}</div></td><td className="mono sm">{g.oidcName || '–'}</td>
        <td className="sm">{g.roleIds.map(id => roles.data!.roles.find(r => r.id === id)?.name).join(', ') || '–'}</td>
        <td className="sm">{members(g.id).map(u => u.name).join(', ') || '–'}</td>
        <td><button className="btn sm" onClick={() => setEdit({ ...g, members: members(g.id).map(u => u.id) })}>Edit</button></td></tr>)}
    </tbody></table></div>
    {edit && <Drawer title={edit.id ? `Edit ${edit.name}` : 'Add group'} onClose={() => setEdit(null)} footer={<>
      <button className="btn primary" disabled={busy === 'save'} onClick={() => run('save', async () => { await api.saveGroup({ id: edit.id, name: edit.name!, description: edit.description, oidcName: edit.oidcName, roleIds: edit.roleIds }, edit.members); setEdit(null); await groups.reload(); await users.reload(); await refreshDir(); }, 'Group saved.')}>Save</button>
      {edit.id && <Confirm text="Delete group?" danger onYes={() => run('del', async () => { await api.deleteGroup(edit.id!); setEdit(null); await groups.reload(); await refreshDir(); }, 'Group deleted.')}><button className="btn ghost">Delete</button></Confirm>}
      <button className="btn" onClick={() => setEdit(null)}>Cancel</button></>}>
      <Field label="Name" id="g-n"><input id="g-n" value={edit.name ?? ''} onChange={e => setEdit({ ...edit, name: e.target.value })} /></Field>
      <Field label="Description" id="g-d"><input id="g-d" value={edit.description ?? ''} onChange={e => setEdit({ ...edit, description: e.target.value })} /></Field>
      <Field label="Matching group in your identity provider" id="g-o" hint="SSO users in that group join this one automatically at sign-in."><input id="g-o" className="mono" value={edit.oidcName ?? ''} onChange={e => setEdit({ ...edit, oidcName: e.target.value })} placeholder="aerotrace-der" /></Field>
      <Checks label="Roles members get" options={roles.data.roles.map(r => ({ id: r.id, label: r.name }))} value={edit.roleIds ?? []} onChange={v => setEdit({ ...edit, roleIds: v })} />
      <Checks label="Members" options={dir.users.map(u => ({ id: u.id, label: u.name, hint: u.email }))} value={edit.members} onChange={v => setEdit({ ...edit, members: v })} />
    </Drawer>}
  </>;
}

function Roles() {
  const { api } = useApp();
  const { data, error, reload } = useLoad(() => api.roles(), []);
  const [edit, setEdit] = useState<(Partial<Role> & { permissions: Permission[] }) | null>(null);
  const { busy, run } = useAction();
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return <>
    <div className="row"><button className="btn primary" onClick={() => setEdit({ name: '', description: '', permissions: ['audit.view'] })}>Add role</button><span className="dim sm">Approving and denying is not a permission. It comes from approval policies.</span></div>
    <div className="tbl"><table><thead><tr><th>Role</th><th>Permissions</th><th /></tr></thead><tbody>
      {data.roles.map(r => <tr key={r.id}><td><b style={{ fontWeight: 600 }}>{r.name}</b>{r.builtIn && <span className="pill" style={{ marginLeft: 6 }}>built-in</span>}<div className="dim sm">{r.description}</div></td>
        <td className="sm">{r.permissions.map(p => data.permissions.find(x => x.id === p)?.label).join(' · ')}</td><td><button className="btn sm" onClick={() => setEdit({ ...r })}>Edit</button></td></tr>)}
    </tbody></table></div>
    {edit && <Drawer title={edit.id ? `Edit ${edit.name}` : 'Add role'} onClose={() => setEdit(null)} footer={<>
      <button className="btn primary" disabled={busy === 'save'} onClick={() => run('save', async () => { await api.saveRole({ id: edit.id, name: edit.name!, description: edit.description, permissions: edit.permissions }); setEdit(null); await reload(); }, 'Role saved.')}>Save</button>
      {edit.id && !edit.builtIn && <Confirm text="Delete role?" danger onYes={() => run('del', async () => { await api.deleteRole(edit.id!); setEdit(null); await reload(); }, 'Role deleted.')}><button className="btn ghost">Delete</button></Confirm>}
      <button className="btn" onClick={() => setEdit(null)}>Cancel</button></>}>
      <Field label="Name" id="r-n"><input id="r-n" value={edit.name ?? ''} onChange={e => setEdit({ ...edit, name: e.target.value })} /></Field>
      <Field label="Description" id="r-d"><input id="r-d" value={edit.description ?? ''} onChange={e => setEdit({ ...edit, description: e.target.value })} /></Field>
      <Checks label="Permissions" options={data.permissions.map(p => ({ id: p.id, label: p.label, hint: p.id }))} value={edit.permissions} onChange={v => setEdit({ ...edit, permissions: v })} />
    </Drawer>}
  </>;
}

function InviteDialog({ link, onClose }: { link: InviteLink; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return <Drawer title={`Invite link for ${link.name}`} onClose={onClose} footer={<button className="btn primary" onClick={onClose}>Done</button>}>
    <p className="dim2" style={{ margin: 0 }}>Send this to <b>{link.email}</b> through your usual channel (chat, email or in person). Opening it lets them set up a passkey on their own device. It works once and expires {when(link.expiresAt)}. Creating a new link cancels this one.</p>
    <Field label="Invite link" id="inv-url"><input id="inv-url" className="mono" readOnly value={link.url} onFocus={e => e.currentTarget.select()} /></Field>
    <div className="row"><button className="btn" onClick={async () => { try { await navigator.clipboard.writeText(link.url); setCopied(true); } catch { setCopied(false); } }}>{copied ? 'Copied' : 'Copy link'}</button></div>
  </Drawer>;
}
