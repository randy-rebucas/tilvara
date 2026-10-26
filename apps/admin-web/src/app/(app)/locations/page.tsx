import Link from 'next/link';
import { ReasonAction } from '@/components/actions';
import { Callout, Empty, Note, PageHeader, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { api, apiOrNull, type Branch, type LegalEntity, type Me, type Register, type Terminal } from '@/lib/api';
import { formatDateTime, formatTin } from '@/lib/format';
import { getT } from '@/i18n/server';
import { AddBranchForm, AddEntityForm, AddRegisterForm, EditBranchForm, EditRegisterForm, PairTerminalForm, RowAction } from './forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('locations');

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
  // A second live entity is the plan's `multi_entity` (the API refuses it too).
  const secondEntityOff = activeEntities.length > 0 && !(me.activeTenant?.features?.includes('multi_entity') ?? true);
  const activeBranches = branches?.data.filter((b) => !b.archivedAt) ?? [];
  const activeRegisters = registers?.data.filter((r) => !r.archivedAt) ?? [];
  const entityName = new Map(entities?.data.map((e) => [e.id, e.registeredName]));
  const branchOf = new Map(branches?.data.map((b) => [b.id, b]));
  const registerOf = new Map(registers?.data.map((r) => [r.id, r]));
  const entityStatus = (e: LegalEntity) => <span className="tag">{e.archivedAt ? t('common.archived') : t('common.active')}</span>;
  const entityAction = (e: LegalEntity) =>
    canManage && !e.archivedAt ? <RowAction url={`/api/v1/legal-entities/${e.id}/archive`} label={t('loc.archive')} confirmText={t('common.confirmArchive')} /> : null;
  const vat = (e: LegalEntity) => (e.vatStatus === 'VAT' ? t('loc.vatReg') : t('loc.nonVat'));
  const registerAction = (r: Register) =>
    r.archivedAt ? <span className="tag">{t('common.archived')}</span> : canManage ? (
      <span className="inline-flex flex-wrap items-center justify-end gap-2">
        <EditRegisterForm register={r} />
        <RowAction url={`/api/v1/registers/${r.id}/archive`} label={t('loc.archive')} confirmText={t('common.confirmArchive')} />
      </span>
    ) : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={t('loc.title')} lede={t('loc.lede')} />
      <Callout tone="info">{t('loc.invoicingOff')}</Callout>

      {/* Legal entities — violet (locations) */}
      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="section-title">{t('loc.entities')}</h2>
          {canManage && !secondEntityOff && <AddEntityForm />}
          {canManage && secondEntityOff && <p className="max-w-[36rem] text-[0.875rem] text-muted">{t('loc.multiEntityNotOnPlan')}</p>}
        </div>
        <Note denom="violet" className="pr-2">
          {entities && entities.data.length > 0 ? (
            <RecordTable
              rows={entities.data}
              rowKey={(e) => e.id}
              dimmed={(e) => !!e.archivedAt}
              columns={[
                { header: t('loc.registeredName'), cell: (e) => <Link href={`/locations/entities/${e.id}`} className="font-semibold underline">{e.registeredName}</Link> },
                { header: t('loc.tin'), cell: (e) => <Serial className="text-ink">{formatTin(e.tin)}</Serial> },
                { header: t('loc.vat'), cell: vat },
                { header: t('common.status'), cell: entityStatus },
                { header: '', cell: (e) => <div className="text-right">{entityAction(e)}</div> },
              ]}
              stacked={{
                title: (e) => <Link href={`/locations/entities/${e.id}`} className="underline">{e.registeredName}</Link>,
                meta: (e) => `TIN ${formatTin(e.tin)} · ${vat(e)}${e.archivedAt ? ` · ${t('common.archived')}` : ''}`,
                figure: entityAction,
              }}
            />
          ) : (
            <Empty>{entities ? t('loc.emptyEntities') : t('common.noAccess')}</Empty>
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
          <Note denom="violet">
            <Empty>{!branches ? t('common.noAccess') : activeEntities.length > 0 ? t('loc.emptyBranches') : t('loc.emptyBranchesNoEntity')}</Empty>
          </Note>
        )}
      </section>

      {/* Registers & terminals — orange */}
      <section className="grid gap-6 xl:grid-cols-2">
        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="section-title">{t('loc.registers')}</h2>
            {canManage && activeBranches.length > 0 && <AddRegisterForm branches={activeBranches} />}
          </div>
          <Note denom="orange" className="pr-2">
            {registers && registers.data.length > 0 ? (
              <RecordTable
                rows={registers.data}
                rowKey={(r) => r.id}
                dimmed={(r) => !!r.archivedAt}
                columns={[
                  { header: t('loc.registerCode'), cell: (r) => <Serial className="text-ink">{r.code}</Serial> },
                  { header: t('loc.registerName'), cell: (r) => r.name },
                  { header: t('loc.branches'), cell: (r) => branchOf.get(r.branchId)?.code ?? '—' },
                  { header: '', cell: (r) => <div className="text-right">{registerAction(r)}</div> },
                ]}
                stacked={{
                  title: (r) => r.name,
                  meta: (r) => <Serial>{r.code} · {branchOf.get(r.branchId)?.code ?? '—'}</Serial>,
                  figure: registerAction,
                }}
              />
            ) : (
              <Empty>{!registers ? t('common.noAccess') : activeBranches.length > 0 ? t('loc.emptyRegisters') : t('loc.emptyRegistersNoBranch')}</Empty>
            )}
          </Note>
        </div>

        <div className="min-w-0">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="section-title">{t('loc.terminals')}</h2>
            {canTerminals && activeRegisters.length > 0 && <PairTerminalForm registers={activeRegisters} />}
          </div>
          <Note denom="orange" className="pr-2">
            {terminals && terminals.data.length > 0 ? (
              <ul data-testid="terminals">
                {terminals.data.map((x) => (
                  <li key={x.id} data-terminal={x.id} className={`flex flex-wrap items-start justify-between gap-3 border-b border-hair-soft px-4 py-3 last:border-0 ${x.status === 'REVOKED' ? 'text-muted' : ''}`}>
                    <div className="min-w-0">
                      <p className="font-semibold">
                        {x.name}{' '}
                        {x.status === 'ACTIVE' ? (
                          <span className="tag ml-1">{t('common.active')}</span>
                        ) : (
                          <span className="tag ml-1 text-red!" title={formatDateTime(x.revokedAt, lang)}>{t('common.revoked')}</span>
                        )}
                      </p>
                      <Serial className="mt-1 block">
                        {registerOf.get(x.registerId)?.code ?? '—'} · {t('loc.key')} <span className="normal-case">…{x.credentialHint}</span>
                      </Serial>
                      <p className="mt-1 text-[0.8125rem] text-muted">
                        {t('loc.terminalId')}: <span className="break-all font-[family-name:var(--font-serial)] text-ink">{x.id}</span>
                      </p>
                    </div>
                    {x.status === 'ACTIVE' && canTerminals && (
                      <ReasonAction url={`/api/v1/terminals/${x.id}/revoke`} label={t('loc.revoke')} reasonLabel={t('loc.revokeReason')} hint={t('loc.revokeHint')} danger />
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>{!terminals ? t('common.noAccess') : activeRegisters.length > 0 ? t('loc.emptyTerminals') : t('loc.emptyTerminalsNoRegister')}</Empty>
            )}
          </Note>
        </div>
      </section>
    </div>
  );
}
