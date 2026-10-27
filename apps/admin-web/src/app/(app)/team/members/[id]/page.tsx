import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ReasonAction } from '@/components/actions';
import { Note, Serial } from '@/components/note';
import { api, apiOrNull, type Branch, type LegalEntity, type Me, type Member, type Register, type Role } from '@/lib/api';
import { isUuid } from '@/lib/options';
import { canGrantRole, canManageMember } from '@/lib/team-access';
import { en, type MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { RowAction } from '../../../locations/forms';
import { AccessForm } from '../../forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('team.members.item');

/** One member: their roles and where each applies, with "Change access" for those who may grant them. */
export default async function MemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t } = await getT();
  const [me, members, roles, branches, entities, registers, mfa] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<{ data: Member[] }>('/members'),
    apiOrNull<{ data: Role[] }>('/roles'),
    apiOrNull<{ data: Branch[] }>('/branches'),
    apiOrNull<{ data: LegalEntity[] }>('/legal-entities'),
    apiOrNull<{ data: Register[] }>('/registers'),
    apiOrNull<{ data: { userId: string; enrolled: boolean }[] }>('/members/mfa'),
  ]);
  const member = members?.data.find((m) => m.membershipId === id);
  if (!member) notFound();
  const perms = me.activeTenant?.permissions ?? [];
  const isMe = member.user.id === me.userId;
  // Only someone whose access you could have given yourself (the API refuses the others, e.g. an Owner for an Administrator).
  const canManage = perms.includes('members.manage') && canManageMember(member, roles?.data ?? [], perms);
  const roleName = (roleId: string) => roles?.data.find((r) => r.id === roleId)?.name ?? '—';
  const where = (type: string, scopeId: string | null) =>
    type === 'TENANT'
      ? t('team.wholeBusiness')
      : type === 'BRANCH'
        ? (branches?.data.find((b) => b.id === scopeId)?.code ?? '—')
        : type === 'LEGAL_ENTITY'
          ? t('team.legalEntity', { name: entities?.data.find((e) => e.id === scopeId)?.registeredName ?? '—' })
          : t('team.scopeRegister', { code: registers?.data.find((r) => r.id === scopeId)?.code ?? '—' });
  const status = (s: string) => (`status.${s}` in en ? t(`status.${s}` as MessageKey) : s);
  const enrolled = mfa?.data.find((x) => x.userId === member.user.id)?.enrolled ?? false;

  const liveBranches = (branches?.data ?? []).filter((b) => !b.archivedAt);
  const liveEntities = (entities?.data ?? []).filter((e) => !e.archivedAt);
  // A scope the picker does not list (an archived branch or entity, a register) stays a choice, so the form shows what is saved.
  const listed = new Set(['TENANT', ...liveBranches.map((b) => `BRANCH:${b.id}`), ...liveEntities.map((e) => `LEGAL_ENTITY:${e.id}`)]);
  const extraScopes = [
    ...new Map(
      member.roles
        .filter((a) => a.scopeType !== 'TENANT' && !listed.has(`${a.scopeType}:${a.scopeId}`))
        .map((a) => {
          const label = where(a.scopeType, a.scopeId);
          return [`${a.scopeType}:${a.scopeId}`, a.scopeType === 'REGISTER' ? label : t('team.scopeArchived', { label })] as const;
        }),
    ),
  ].map(([value, label]) => ({ value, label }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/team" className="text-[0.875rem] text-muted underline">{t('team.title')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{member.user.displayName}{isMe ? ` ${t('team.you')}` : ''}</h1>
        <Serial className="mt-1 block">{member.user.email} · {status(member.status)}{mfa && ` · ${enrolled ? t('team.mfaOn') : t('team.mfaOff')}`}</Serial>
      </div>

      <section>
        <h2 className="section-title mb-3">{t('team.access')}</h2>
        <Note denom="green">
          <ul>
            {member.roles.length > 0 ? member.roles.map((a) => (
              <li key={`${a.roleId}:${a.scopeType}:${a.scopeId}`} className="flex items-baseline justify-between gap-4 border-b border-hair-soft px-4 py-3 last:border-0">
                <Link href={`/team/roles/${a.roleId}`} className="font-semibold underline">{roleName(a.roleId)}</Link>
                <Serial className="text-ink">{where(a.scopeType, a.scopeId)}</Serial>
              </li>
            )) : <li className="px-4 py-3 text-muted">—</li>}
          </ul>
        </Note>
      </section>

      {canManage && member.status !== 'REMOVED' && roles && (
        <div className="flex flex-wrap items-start gap-2">
          <AccessForm
            member={member}
            roles={roles.data.filter((r) => !r.archivedAt && (canGrantRole(r, perms) || member.roles.some((a) => a.roleId === r.id)))}
            branches={liveBranches}
            entities={liveEntities}
            extraScopes={extraScopes}
          />
          {!isMe && member.status === 'ACTIVE' && <RowAction url={`/api/v1/members/${member.membershipId}/suspend`} label={t('team.suspend')} />}
          {!isMe && member.status === 'SUSPENDED' && <RowAction url={`/api/v1/members/${member.membershipId}/reactivate`} label={t('team.reactivate')} />}
          {!isMe && <RowAction url={`/api/v1/members/${member.membershipId}/remove`} label={t('team.remove')} danger confirmText={t('team.removeConfirm')} />}
        </div>
      )}

      {canManage && !isMe && enrolled && member.status !== 'REMOVED' && (
        <section className="flex flex-col gap-2">
          <h2 className="section-title">{t('team.mfaResetTitle')}</h2>
          <p className="max-w-[68ch] text-[0.875rem] text-muted">{t('team.mfaResetLede')}</p>
          <div>
            <ReasonAction url={`/api/v1/members/${member.membershipId}/reset-mfa`} label={t('team.mfaReset')} reasonLabel={t('common.reason')} hint={t('team.mfaResetHint')} danger />
          </div>
        </section>
      )}
    </div>
  );
}
