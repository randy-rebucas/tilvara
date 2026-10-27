import Link from 'next/link';
import { Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type Branch, type Invitation, type LegalEntity, type Me, type Member, type Register, type Role } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { getT } from '@/i18n/server';
import { en, type MessageKey } from '@/i18n/messages';
import { RowAction } from '../locations/forms';
import { canGrantRole, canManageMember } from '@/lib/team-access';
import { InviteForm, NewRoleForm } from './forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('team');

type List<T> = { data: T[] };

export default async function TeamPage() {
  const { t, lang } = await getT();
  const [me, members, roles, invites, branches, entities, registers] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<List<Member>>('/members'),
    apiOrNull<List<Role>>('/roles'),
    apiOrNull<List<Invitation>>('/invitations'),
    apiOrNull<List<Branch>>('/branches'),
    apiOrNull<List<LegalEntity>>('/legal-entities'),
    apiOrNull<List<Register>>('/registers'),
  ]);
  const perms = me.activeTenant?.permissions ?? [];
  const canManage = perms.includes('members.manage');
  const canManageRoles = perms.includes('roles.manage');
  const roleName = new Map(roles?.data.map((r) => [r.key, r.name]));
  const roleById = new Map(roles?.data.map((r) => [r.id, r.name]));
  const branchCode = new Map(branches?.data.map((b) => [b.id, b.code]));
  const registerCode = new Map(registers?.data.map((r) => [r.id, r.code]));
  const entityName = new Map(entities?.data.map((e) => [e.id, e.registeredName]));
  const status = (s: string) => {
    const key = `status.${s}`;
    return key in en ? t(key as MessageKey) : s;
  };
  const scopeLabel = (type: string, id: string | null) =>
    type === 'TENANT'
      ? t('team.wholeBusiness')
      : type === 'LEGAL_ENTITY'
        ? t('team.legalEntity', { name: entityName.get(id ?? '') ?? '—' })
        : type === 'REGISTER'
          ? t('team.scopeRegister', { code: registerCode.get(id ?? '') ?? '—' })
          : (branchCode.get(id ?? '') ?? '—');
  const memberRoles = (m: Member) => m.roles.map((r) => roleName.get(r.roleKey) ?? r.roleKey).join(', ') || '—';
  const memberScopes = (m: Member) => m.roles.map((r) => scopeLabel(r.scopeType, r.scopeId)).join(', ') || '—';
  const memberActions = (m: Member) => {
    // Only people whose access you could have given (the API refuses the others).
    if (!canManage || m.user.id === me.userId || !canManageMember(m, roles?.data ?? [], perms)) return null;
    return (
      <span className="inline-flex flex-wrap justify-end gap-1.5">
        {m.status === 'ACTIVE' && <RowAction url={`/api/v1/members/${m.membershipId}/suspend`} label={t('team.suspend')} />}
        {m.status === 'SUSPENDED' && <RowAction url={`/api/v1/members/${m.membershipId}/reactivate`} label={t('team.reactivate')} />}
        {m.status !== 'REMOVED' && <RowAction url={`/api/v1/members/${m.membershipId}/remove`} label={t('team.remove')} danger confirmText={t('team.removeConfirm')} />}
      </span>
    );
  };
  const memberName = (m: Member) => (
    <Link href={`/team/members/${m.membershipId}`} className="underline">{m.user.displayName}{m.user.id === me.userId ? ` ${t('team.you')}` : ''}</Link>
  );
  const inviteRoles = (i: Invitation) => i.roles.map((r) => roleById.get(r.roleId) ?? '—').join(', ');
  const revoke = (i: Invitation) =>
    canManage && i.status === 'PENDING' ? <RowAction url={`/api/v1/invitations/${i.id}/revoke`} label={t('team.revokeInvite')} danger /> : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={t('team.title')}
        lede={t('team.lede')}
        actions={perms.includes('audit.read') ? <Link href="/audit" className="btn">{t('audit.link')}</Link> : undefined}
      />

      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <h2 className="section-title pt-2">{t('team.members')}</h2>
          {canManage && roles && <InviteForm roles={roles.data.filter((r) => !r.archivedAt && canGrantRole(r, perms))}branches={(branches?.data ?? []).filter((b) => !b.archivedAt)} />}
        </div>
        <Note denom="green" className="pr-2">
          {members && members.data.length > 0 ? (
            <RecordTable
              rows={members.data}
              rowKey={(m) => m.membershipId}
              dimmed={(m) => m.status !== 'ACTIVE'}
              columns={[
                {
                  header: t('team.name'),
                  cell: (m) => (
                    <>
                      <span className="block font-semibold">{memberName(m)}</span>
                      <span className="text-[0.8125rem] text-muted">{m.user.email}</span>
                    </>
                  ),
                },
                { header: t('team.role'), cell: memberRoles },
                { header: t('team.scope'), cell: (m) => <Serial className="text-ink">{memberScopes(m)}</Serial> },
                { header: t('common.status'), cell: (m) => <span className="tag">{status(m.status)}</span> },
                { header: '', cell: (m) => <div className="text-right whitespace-nowrap">{memberActions(m)}</div> },
              ]}
              stacked={{
                title: memberName,
                meta: (m) => (
                  <>
                    <span className="block break-all">{m.user.email}</span>
                    <span className="block">{memberRoles(m)} · {memberScopes(m)} · {status(m.status)}</span>
                  </>
                ),
                figure: memberActions,
              }}
            />
          ) : (
            <Empty>{members ? t('team.noMembers') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>

      <section className="grid gap-6 xl:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-3 flex min-h-9 items-center">
            <h2 className="section-title">{t('team.invitations')}</h2>
          </div>
          <Note denom="green" className="pr-2">
            {invites && invites.data.length > 0 ? (
              <RecordTable
                rows={invites.data}
                rowKey={(i) => i.id}
                dimmed={(i) => i.status !== 'PENDING'}
                columns={[
                  {
                    header: t('auth.email'),
                    cell: (i) => (
                      <>
                        <span className="block">{i.email}</span>
                        <span className="text-[0.8125rem] text-muted">{formatDateTime(i.createdAt, lang)}</span>
                      </>
                    ),
                  },
                  { header: t('team.role'), cell: inviteRoles },
                  { header: t('common.status'), cell: (i) => <span className="tag">{status(i.status)}</span> },
                  { header: '', cell: (i) => <div className="text-right">{revoke(i)}</div> },
                ]}
                stacked={{
                  title: (i) => <span className="break-all">{i.email}</span>,
                  meta: (i) => `${inviteRoles(i)} · ${status(i.status)} · ${formatDateTime(i.createdAt, lang)}`,
                  figure: revoke,
                }}
              />
            ) : (
              <Empty>{invites ? t('team.emptyInvites') : t('common.noAccess')}</Empty>
            )}
          </Note>
        </div>

        <div className="min-w-0">
          <div className="mb-3 flex min-h-9 flex-wrap items-center justify-between gap-3">
            <h2 className="section-title">{t('team.roles')}</h2>
            {canManageRoles && <NewRoleForm extensions={me.activeTenant?.extensions ?? []} />}
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
