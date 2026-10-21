import Link from 'next/link';
import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { apiOrNull, type Branch, type CustomerNote, type CustomerPackage, type CustomerVisits } from '@/lib/api';
import { formatDate, formatDateTime, peso } from '@/lib/format';
import { branchLabel } from '@/lib/options';
import type { MessageKey } from '@/i18n/messages';
import { getT } from '@/i18n/server';
import { ServiceNotes } from './notes';

/**
 * A client's history at a salon (ADR-0022 §8): service notes (pinned first), packages with sessions
 * left and expiry, and visits (appointments and the services rung up, with who did them).
 */
export async function SalonHistory({ customerId, canManage, branches }: { customerId: string; canManage: boolean; branches: Branch[] | undefined }) {
  const { t, lang } = await getT();
  const [visits, packages, notes] = await Promise.all([
    apiOrNull<CustomerVisits>(`/customers/${customerId}/visits`),
    apiOrNull<{ data: CustomerPackage[] }>(`/customers/${customerId}/packages`),
    apiOrNull<{ data: CustomerNote[] }>(`/customers/${customerId}/notes`),
  ]);
  const status = (s: string) => t(`appt.status.${s}` as MessageKey);
  return (
    <>
      {notes && (
        <section aria-labelledby="service-notes">
          <h2 id="service-notes" className="section-title mb-3">{t('cnote.title')}</h2>
          <ServiceNotes customerId={customerId} notes={notes.data} canManage={canManage} />
        </section>
      )}

      {packages && (
        <section aria-labelledby="client-packages">
          <h2 id="client-packages" className="section-title mb-3">{t('cpkg.title')}</h2>
          {packages.data.length === 0 ? (
            <Note denom="none"><Empty>{t('cpkg.empty')}</Empty></Note>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {packages.data.map((p) => {
                const used = p.services.every((s) => s.sessionsLeft === 0);
                return (
                  <Note key={p.id} denom="blue" className={`px-4 py-3 pr-6 ${used || p.expired ? 'opacity-70' : ''}`} as="article">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold">{p.name}</p>
                        <Serial>
                          {t('cpkg.bought', { date: formatDateTime(p.boughtAt, lang) })} ·{' '}
                          {p.expiresOn ? t(p.expired ? 'cpkg.expired' : 'cpkg.expires', { date: formatDate(p.expiresOn, lang) }) : t('cpkg.noExpiry')}
                        </Serial>
                      </div>
                      <div className="text-right">
                        <div className="text-[0.75rem] text-muted">{t('cpkg.valueLeft')}</div>
                        <div className="money font-semibold">{peso(p.valueLeft)}</div>
                      </div>
                    </div>
                    <ul className="mt-2 grid gap-0.5 text-[0.9375rem]">
                      {p.services.map((s) => (
                        <li key={s.itemId} className="flex justify-between gap-3 border-t border-hair-soft pt-1">
                          <span>{s.name}</span>
                          <span className="serial whitespace-nowrap" data-testid="sessions-left">{t('cpkg.sessionsLeft', { left: s.sessionsLeft, of: s.sessions })}</span>
                        </li>
                      ))}
                    </ul>
                    <Link href={`/sales/${p.saleId}`} className="mt-2 inline-block text-[0.8125rem] underline">{t('cpkg.sale')}</Link>
                  </Note>
                );
              })}
            </div>
          )}
        </section>
      )}

      {visits && (
        <section aria-labelledby="client-visits" className="grid gap-3">
          <h2 id="client-visits" className="section-title">{t('visit.title')}</h2>
          <Note denom="none" className="pr-2">
            {visits.appointments.length > 0 ? (
              <RecordTable
                rows={visits.appointments}
                rowKey={(a) => a.id}
                dimmed={(a) => a.status === 'CANCELLED' || a.status === 'NO_SHOW'}
                columns={[
                  { header: t('cust.when'), cell: (a) => <Link href={`/appointments/${a.id}`} className="underline">{formatDateTime(a.startsAt, lang)}</Link> },
                  { header: t('common.branch'), cell: (a) => <Serial className="text-ink">{branchLabel(branches, a.branchId)}</Serial> },
                  { header: t('appt.services'), cell: (a) => a.services.map((s) => `${s.name} · ${s.staffName}`).join(', ') },
                  { header: t('common.status'), cell: (a) => <span className="tag">{status(a.status)}</span> },
                ]}
                stacked={{
                  title: (a) => <Link href={`/appointments/${a.id}`} className="underline">{formatDateTime(a.startsAt, lang)}</Link>,
                  meta: (a) => a.services.map((s) => `${s.name} · ${s.staffName}`).join(', '),
                  figure: (a) => <span className="tag">{status(a.status)}</span>,
                }}
              />
            ) : (
              <Empty>{t('visit.noAppointments')}</Empty>
            )}
          </Note>
          <h3 className="text-[0.9375rem] font-semibold">{t('visit.services')}</h3>
          <Note denom="none" className="pr-2">
            {visits.services.length > 0 ? (
              <RecordTable
                rows={visits.services.map((s, i) => ({ ...s, key: `${s.saleId}-${i}` }))}
                rowKey={(s) => s.key}
                columns={[
                  { header: t('cust.when'), cell: (s) => <Link href={`/sales/${s.saleId}`} className="underline">{formatDateTime(s.completedAt, lang)}</Link> },
                  { header: t('common.item'), cell: (s) => <>{s.name}{s.fromPackage && <span className="tag ml-2">{t('visit.fromPackage')}</span>}</> },
                  { header: t('appt.staff'), cell: (s) => s.staffName ?? '—' },
                  { header: t('doc.amountDue'), num: true, cell: (s) => <span className="money">{peso(s.amountDue)}</span> },
                ]}
                stacked={{
                  title: (s) => <>{s.name}{s.fromPackage && <span className="tag ml-2">{t('visit.fromPackage')}</span>}</>,
                  meta: (s) => <Serial>{formatDateTime(s.completedAt, lang)} · {s.staffName ?? '—'}</Serial>,
                  figure: (s) => <span className="money font-semibold">{peso(s.amountDue)}</span>,
                }}
              />
            ) : (
              <Empty>{t('visit.noServices')}</Empty>
            )}
          </Note>
        </section>
      )}
    </>
  );
}
