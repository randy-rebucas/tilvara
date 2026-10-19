import Link from 'next/link';
import { Callout, Empty, Note, PageHeader, Serial } from '@/components/note';
import { api, apiOrNull, type Branch, type LegalEntity, type Me, type Register, type Terminal } from '@/lib/api';
import { formatDateTime, formatTin } from '@/lib/format';
import { getT } from '@/i18n/server';
import { AddBranchForm, AddEntityForm, AddRegisterForm, EditBranchForm, EditRegisterForm, PairTerminalForm, RowAction } from './forms';

export const metadata = { title: 'Locations' };

type List<T> = { data: T[] };

export default async function LocationsPage() {
  const { t, lang } = await getT();
  const [me, entities, branches, registers, terminals] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<List<LegalEntity>>('/legal-entities'),
    apiOrNull<List<Branch>>('/branches'),
    apiOrNull<List<Register>>('/registers'),
    apiOrNull<List<Terminal>>('/terminals'),
  ]);
  const perms = me.activeTenant?.permissions ?? [];
  const canManage = perms.includes('org.manage');
  const canTerminals = perms.includes('terminals.manage');
  const activeEntities = entities?.data.filter((e) => !e.archivedAt) ?? [];
  const activeBranches = branches?.data.filter((b) => !b.archivedAt) ?? [];
  const activeRegisters = registers?.data.filter((r) => !r.archivedAt) ?? [];
  const entityName = new Map(entities?.data.map((e) => [e.id, e.registeredName]));
  const branchOf = new Map(branches?.data.map((b) => [b.id, b]));
  const registerOf = new Map(registers?.data.map((r) => [r.id, r]));

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t('loc.title')} lede={t('loc.lede')} />
      <Callout tone="info">{t('loc.invoicingOff')}</Callout>

      {/* Legal entities — violet (locations) */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="section-title">{t('loc.entities')}</h2>
          {canManage && <AddEntityForm />}
        </div>
        <Note denom="violet" className="overflow-x-auto pr-2">
          {entities && entities.data.length > 0 ? (
            <table className="tbl">
              <thead><tr><th>{t('loc.registeredName')}</th><th>{t('loc.tin')}</th><th>{t('loc.vat')}</th><th>{t('common.status')}</th><th /></tr></thead>
              <tbody>
                {entities.data.map((e) => (
                  <tr key={e.id} className={e.archivedAt ? 'text-muted' : ''}>
                    <td><Link href={`/locations/entities/${e.id}`} className="font-semibold underline">{e.registeredName}</Link></td>
                    <td><Serial className="text-ink">{formatTin(e.tin)}</Serial></td>
                    <td>{e.vatStatus === 'VAT' ? t('loc.vatReg') : t('loc.nonVat')}</td>
                    <td><span className="tag">{e.archivedAt ? t('common.archived') : t('common.active')}</span></td>
                    <td className="text-right">
                      {canManage && !e.archivedAt && (
                        <RowAction url={`/api/v1/legal-entities/${e.id}/archive`} label={t('loc.archive')} confirmText={t('common.confirmArchive')} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Empty>{entities ? t('loc.empty') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>

      {/* Branches — fixed-scale cards so branches compare at a glance */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="section-title">{t('loc.branches')}</h2>
          {canManage && activeEntities.length > 0 && <AddBranchForm entities={activeEntities} />}
        </div>
        {branches && branches.data.length > 0 ? (
          <ul className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
            {branches.data.map((b) => {
              const regs = activeRegisters.filter((r) => r.branchId === b.id).length;
              return (
                <Note as="li" key={b.id} denom={b.archivedAt ? 'none' : 'violet'} className="flex min-h-[148px] flex-col px-4 py-4 pr-6">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-[1.0625rem] font-semibold">{b.name}</span>
                    {b.archivedAt && <span className="tag">{t('common.archived')}</span>}
                  </div>
                  <Serial className="mt-1 block truncate">
                    <span className="font-semibold text-violet">{b.code}</span> · BIR {b.birBranchCode} · {entityName.get(b.legalEntityId) ?? '—'}
                  </Serial>
                  <span className="mt-1 block truncate text-[0.8125rem] text-muted" title={b.address ?? undefined}>{b.address ?? t('loc.noAddress')}</span>
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-2">
                    <span className="text-[0.875rem] text-muted">{t('loc.registers')}: <b className="text-ink tabular-nums">{regs}</b></span>
                    {canManage && !b.archivedAt && (
                      <span className="flex flex-wrap items-center gap-2">
                        <EditBranchForm branch={b} />
                        <RowAction url={`/api/v1/branches/${b.id}/archive`} label={t('loc.archive')} confirmText={t('common.confirmArchive')} />
                      </span>
                    )}
                  </div>
                </Note>
              );
            })}
          </ul>
        ) : (
          <Note><Empty>{branches ? t('loc.empty') : t('common.noAccess')}</Empty></Note>
        )}
      </section>

      {/* Registers & terminals — orange */}
      <section className="grid gap-6 xl:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="section-title">{t('loc.registers')}</h2>
            {canManage && activeBranches.length > 0 && <AddRegisterForm branches={activeBranches} />}
          </div>
          <Note denom="orange" className="overflow-x-auto pr-2">
            {registers && registers.data.length > 0 ? (
              <table className="tbl">
                <thead><tr><th>{t('loc.registerCode')}</th><th>{t('loc.registerName')}</th><th>{t('loc.branches')}</th><th /></tr></thead>
                <tbody>
                  {registers.data.map((r) => (
                    <tr key={r.id} className={r.archivedAt ? 'text-muted' : ''}>
                      <td><Serial className="text-ink">{r.code}</Serial></td>
                      <td>{r.name}</td>
                      <td>{branchOf.get(r.branchId)?.code ?? '—'}</td>
                      <td className="text-right">
                        {r.archivedAt ? <span className="tag">{t('common.archived')}</span> : canManage && (
                          <span className="inline-flex flex-wrap items-center justify-end gap-2">
                            <EditRegisterForm register={r} />
                            <RowAction url={`/api/v1/registers/${r.id}/archive`} label={t('loc.archive')} confirmText={t('common.confirmArchive')} />
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>{registers ? t('loc.empty') : t('common.noAccess')}</Empty>
            )}
          </Note>
        </div>

        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="section-title">{t('loc.terminals')}</h2>
            {canTerminals && activeRegisters.length > 0 && <PairTerminalForm registers={activeRegisters} />}
          </div>
          <Note denom="orange" className="overflow-x-auto pr-2">
            {terminals && terminals.data.length > 0 ? (
              <table className="tbl">
                <thead><tr><th>{t('loc.terminalName')}</th><th>{t('loc.registers')}</th><th>{t('loc.key')}</th><th>{t('common.status')}</th><th /></tr></thead>
                <tbody>
                  {terminals.data.map((x) => (
                    <tr key={x.id} className={x.status === 'REVOKED' ? 'text-muted' : ''}>
                      <td>{x.name}</td>
                      <td>{registerOf.get(x.registerId)?.code ?? '—'}</td>
                      <td><Serial className="normal-case">…{x.credentialHint}</Serial></td>
                      <td>
                        {x.status === 'ACTIVE' ? (
                          <span className="tag">{t('common.active')}</span>
                        ) : (
                          <span className="tag text-red!" title={formatDateTime(x.revokedAt, lang)}>{t('common.revoked')}</span>
                        )}
                      </td>
                      <td className="text-right">
                        {x.status === 'ACTIVE' && canTerminals && (
                          <RowAction url={`/api/v1/terminals/${x.id}/revoke`} label={t('loc.revoke')} danger body={{ reason: 'Revoked from admin' }} confirmText={t('common.confirmRevoke')} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <Empty>{terminals ? t('loc.empty') : t('common.noAccess')}</Empty>
            )}
          </Note>
        </div>
      </section>
    </div>
  );
}
