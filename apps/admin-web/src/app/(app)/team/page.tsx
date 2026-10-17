import Link from 'next/link';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { api, apiOrNull, type Branch, type Invitation, type Me, type Member, type Role } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { getT } from '@/i18n/server';
import { en, type MessageKey } from '@/i18n/messages';
import { RowAction } from '../locations/forms';
import { InviteForm, NewRoleForm } from './forms';

export const metadata = { title: 'Team' };

type List<T> = { data: T[] };

export default async function TeamPage() {
  const { t, lang } = await getT();
  const [me, members, roles, invites, branches] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<List<Member>>('/members'),
    apiOrNull<List<Role>>('/roles'),
    apiOrNull<List<Invitation>>('/invitations'),
    apiOrNull<List<Branch>>('/branches'),
  ]);
  const perms = me.activeTenant?.permissions ?? [];
  const canManage = perms.includes('members.manage');
  const canManageRoles = perms.includes('roles.manage');
  const roleName = new Map(roles?.data.map((r) => [r.key, r.name]));
  const roleById = new Map(roles?.data.map((r) => [r.id, r.name]));
  const branchCode = new Map(branches?.data.map((b) => [b.id, b.code]));
  const status = (s: string) => {
    const key = `status.${s}`;
    return key in en ? t(key as MessageKey) : s;
  };
  const scopeLabel = (type: string, id: string | null) => (type === 'TENANT' ? t('team.wholeBusiness') : branchCode.get(id ?? '') ?? type);

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t('team.title')} lede={t('team.lede')} />

      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('team.members')}</h2>
          {canManage && roles && <InviteForm roles={roles.data} branches={(branches?.data ?? []).filter((b) => !b.archivedAt)} />}
        </div>
        <Note denom="green" className="overflow-x-auto pr-2">
          {members && members.data.length > 0 ? (
            <table className="tbl">
              <thead><tr><th>{t('team.name')}</th><th>{t('team.role')}</th><th>{t('team.scope')}</th><th>{t('common.status')}</th><th /></tr></thead>
              <tbody>
                {members.data.map((m) => {
                  const isMe = m.user.id === me.userId;
                  return (
                    <tr key={m.membershipId} className={m.status !== 'ACTIVE' ? 'text-muted' : ''}>
                      <td>
                        <Link href={`/team/members/${m.membershipId}`} className="block font-semibold underline">{m.user.displayName}{isMe ? ` ${t('team.you')}` : ''}</Link>
                        <span className="text-[0.8125rem] text-muted">{m.user.email}</span>
                      </td>
                      <td>{m.roles.map((r) => roleName.get(r.roleKey) ?? r.roleKey).join(', ') || '—'}</td>
                      <td><Serial className="text-ink">{m.roles.map((r) => scopeLabel(r.scopeType, r.scopeId)).join(', ') || '—'}</Serial></td>
                      <td><span className="tag">{status(m.status)}</span></td>
                      <td className="text-right whitespace-nowrap">
                        {canManage && !isMe && m.status === 'ACTIVE' && (
                          <RowAction url={`/api/v1/members/${m.membershipId}/suspend`} label={t('team.suspend')} />
                        )}
                        {canManage && !isMe && m.status === 'SUSPENDED' && (
                          <RowAction url={`/api/v1/members/${m.membershipId}/reactivate`} label={t('team.reactivate')} />
                        )}{' '}
                        {canManage && !isMe && m.status !== 'REMOVED' && (
                          <RowAction url={`/api/v1/members/${m.membershipId}/remove`} label={t('team.remove')} danger confirmText={t('common.confirmArchive')} />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <Empty>{members ? t('loc.empty') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="min-w-0">
          <h2 className="section-title mb-3">{t('team.invitations')}</h2>
          <Note denom="green" className="overflow-x-auto pr-2">
            {invites && invites.data.length > 0 ? (
              <table className="tbl">
                <thead><tr><th>{t('auth.email')}</th><th>{t('team.role')}</th><th>{t('common.status')}</th><th /></tr></thead>
                <tbody>
                  {invites.data.map((i) => (
                    <tr key={i.id} className={i.status !== 'PENDING' ? 'text-muted' : ''}>
                      <td>
                        <span className="block">{i.email}</span>
                        <span className="text-[0.8125rem] text-muted">{formatDateTime(i.createdAt, lang)}</span>
                      </td>
                      <td>{i.roles.map((r) => roleById.get(r.roleId) ?? '—').join(', ')}</td>
                      <td><span className="tag">{status(i.status)}</span></td>
                      <td className="text-right">
                        {canManage && i.status === 'PENDING' && <RowAction url={`/api/v1/invitations/${i.id}/revoke`} label={t('team.revokeInvite')} danger />}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>{invites ? t('loc.empty') : t('common.noAccess')}</Empty>
            )}
          </Note>
        </div>

        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
            <h2 className="section-title pt-2">{t('team.roles')}</h2>
            {canManageRoles && <NewRoleForm />}
          </div>
          <Note className="overflow-x-auto">
            {roles ? (
              <ul>
                {roles.data.filter((r) => !r.archivedAt).map((r) => (
                  <li key={r.id} className="flex items-baseline justify-between gap-4 border-b border-hair-soft px-4 py-3 last:border-0">
                    <span>
                      <Link href={`/team/roles/${r.id}`} className="font-semibold underline">{r.name}</Link>{' '}
                      {r.isSystem && <span className="tag ml-1">{t('team.system')}</span>}
                    </span>
                    <Serial>{t('team.perms', { n: r.permissions.length })}</Serial>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>{t('common.noAccess')}</Empty>
            )}
          </Note>
          <p className="mt-2 text-[0.8125rem] text-muted">{t('team.customRoles')}</p>
        </div>
      </section>
    </div>
  );
}
