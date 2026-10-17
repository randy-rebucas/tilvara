import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/actions';
import { Callout, Empty, Note, Serial } from '@/components/note';
import { api, apiOrNull, type Me, type Member, type Role } from '@/lib/api';
import { isUuid } from '@/lib/options';
import { PERMISSION_GROUPS, PRIVILEGED_PERMISSIONS } from '@/lib/permissions';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { EditRoleForm } from '../../forms';

export const metadata = { title: 'Role' };

/** One role: what it allows in words, who holds it, and edit/archive for custom roles. */
export default async function RolePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t } = await getT();
  const [me, roles, members] = await Promise.all([api<Me>('/me'), apiOrNull<{ data: Role[] }>('/roles'), apiOrNull<{ data: Member[] }>('/members')]);
  const role = roles?.data.find((r) => r.id === id);
  if (!role) notFound();
  const canManage = (me.activeTenant?.permissions.includes('roles.manage') ?? false) && !role.isSystem && !role.archivedAt;
  const holders = members?.data.filter((m) => m.status !== 'REMOVED' && m.roles.some((a) => a.roleId === role.id)) ?? [];
  const granted = PERMISSION_GROUPS.map((g) => ({ ...g, codes: g.codes.filter((c) => role.permissions.includes(c)) })).filter((g) => g.codes.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/team" className="text-[0.875rem] text-muted underline">{t('team.title')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">
          {role.name} {role.isSystem && <span className="tag ml-1 align-middle">{t('team.system')}</span>}
          {role.archivedAt && <span className="tag ml-1 align-middle">{t('team.roleArchived')}</span>}
        </h1>
        <Serial className="mt-1 block">{role.key} · {t('team.perms', { n: role.permissions.length })}</Serial>
      </div>

      {role.isSystem && <Callout>{t('team.systemReadonly')}</Callout>}

      {canManage && (
        <div className="flex flex-wrap items-start gap-2">
          <EditRoleForm role={role} />
          <ActionButton url={`/api/v1/roles/${role.id}/archive`} label={t('team.archiveRole')} confirmText={t('team.archiveRoleConfirm', { name: role.name })} />
        </div>
      )}

      <section>
        <h2 className="section-title mb-3">{t('team.permissions')}</h2>
        <Note denom="green" className="grid gap-4 px-5 py-4 pr-8 md:grid-cols-2">
          {granted.map((g) => (
            <div key={g.key}>
              <p className="mb-1 text-[0.8125rem] font-semibold uppercase tracking-[0.06em] text-muted">{t(`permGroup.${g.key}` as MessageKey)}</p>
              <ul className="grid gap-0.5 text-[0.9375rem]">
                {g.codes.map((c) => (
                  <li key={c}>
                    {t(`perm.${c}` as MessageKey)}
                    {PRIVILEGED_PERMISSIONS.includes(c) && <span className="ml-1.5 text-[0.75rem] text-muted">({t('team.privileged')})</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Note>
      </section>

      <section>
        <h2 className="section-title mb-3">{t('team.holders')}</h2>
        <Note denom="green">
          {holders.length > 0 ? (
            <ul>
              {holders.map((m) => (
                <li key={m.membershipId} className="border-b border-hair-soft px-4 py-3 last:border-0">
                  <Link href={`/team/members/${m.membershipId}`} className="font-semibold underline">{m.user.displayName}</Link>
                  <Serial className="ml-2">{m.user.email}</Serial>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>{members ? t('team.noHolders') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>
    </div>
  );
}
