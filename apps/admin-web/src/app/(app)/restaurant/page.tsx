import { Empty, Note, Serial } from '@/components/note';
import { RecordTable } from '@/components/record-table';
import { apiOrNull, type DiningArea, type KitchenStation } from '@/lib/api';
import { getT } from '@/i18n/server';
import { RestaurantChrome, restaurantBranch } from './chrome';
import { AreaForm, EditRecord, EditTablesForm, RowAction, StationForm, TableForm } from './forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('restaurant');

/** Kitchen stations and the dining floor of one branch (ADR-0014 §5). */
export default async function FloorPage({ searchParams }: { searchParams: Promise<{ branch?: string }> }) {
  const { t } = await getT();
  const { branches, branch } = await restaurantBranch((await searchParams).branch);
  const [stations, areas] = branch
    ? await Promise.all([
        apiOrNull<{ data: KitchenStation[] }>(`/kitchen-stations?branchId=${branch.id}`),
        apiOrNull<{ data: DiningArea[] }>(`/dining-areas?branchId=${branch.id}`),
      ])
    : [null, null];

  return (
    <RestaurantChrome tab="floor" branches={branches} branch={branch}>
      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-title pt-2">{t('rest.stations')}</h2>
            <p className="mt-1 max-w-[68ch] text-[0.875rem] text-muted">{t('rest.stationsLede')}</p>
          </div>
          {branch && stations && <StationForm branchId={branch.id} />}
        </div>
        <Note denom="violet" className="pr-2">
          {stations && stations.data.length > 0 ? (
            <RecordTable
              rows={stations.data}
              rowKey={(s) => s.id}
              columns={[
                { header: t('rest.stationCode'), cell: (s) => <Serial className="text-violet">{s.code}</Serial> },
                { header: t('common.name'), cell: (s) => <>{s.name} {s.isDefault && <span className="chip ml-2 bg-violet">{t('rest.default')}</span>}</> },
                {
                  header: <span className="sr-only">{t('common.actions')}</span>,
                  num: true,
                  cell: (s) => (
                    <span className="inline-flex flex-wrap justify-end gap-2">
                      <EditRecord label={t('rest.rename')} url={`/api/v1/kitchen-stations/${s.id}`} fields={[{ name: 'name', label: t('common.name'), value: s.name }]} />
                      {!s.isDefault && <RowAction method="PATCH" url={`/api/v1/kitchen-stations/${s.id}`} body={{ isDefault: true }} label={t('rest.makeDefault')} />}
                      <RowAction url={`/api/v1/kitchen-stations/${s.id}/archive`} label={t('common.archive')} danger confirmText={t('rest.archiveConfirm', { name: s.name })} />
                    </span>
                  ),
                },
              ]}
              stacked={{
                title: (s) => <>{s.name} {s.isDefault && <span className="chip ml-1 bg-violet">{t('rest.default')}</span>}</>,
                meta: (s) => <Serial className="text-violet">{s.code}</Serial>,
                figure: (s) => (
                  <span className="flex flex-col items-end gap-2">
                    <EditRecord label={t('rest.rename')} url={`/api/v1/kitchen-stations/${s.id}`} fields={[{ name: 'name', label: t('common.name'), value: s.name }]} />
                    <RowAction url={`/api/v1/kitchen-stations/${s.id}/archive`} label={t('common.archive')} danger confirmText={t('rest.archiveConfirm', { name: s.name })} />
                  </span>
                ),
              }}
            />
          ) : (
            <Empty>{stations ? t('rest.noStations') : t('common.noAccess')}</Empty>
          )}
        </Note>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="section-title pt-2">{t('rest.floor')}</h2>
            <p className="mt-1 max-w-[68ch] text-[0.875rem] text-muted">{t('rest.floorLede')}</p>
          </div>
          {branch && areas && <AreaForm branchId={branch.id} />}
        </div>
        {areas && areas.data.length > 0 ? (
          <div className="flex flex-col gap-4">
            {areas.data.map((a) => (
              <Note key={a.id} denom="violet" className="flex flex-col gap-3 p-4 pr-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-[1.0625rem] font-semibold">{a.name} <Serial>· {t('rest.tableCount', { n: a.tables.length })}</Serial></h3>
                  <span className="flex flex-wrap items-start gap-2">
                    <EditRecord label={t('rest.rename')} url={`/api/v1/dining-areas/${a.id}`} fields={[{ name: 'name', label: t('rest.areaName'), value: a.name }]} />
                    {a.tables.length === 0 && <RowAction url={`/api/v1/dining-areas/${a.id}/archive`} label={t('common.archive')} danger confirmText={t('rest.archiveConfirm', { name: a.name })} />}
                  </span>
                </div>
                {a.tables.length > 0 && (
                  <ul className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                    {a.tables.map((tb) => (
                      <li key={tb.id} className="flex items-center justify-between gap-2 rounded-[5px] border border-hair-soft px-3 py-2">
                        <span>
                          <span className="serial font-semibold text-violet">{tb.code}</span>
                          <span className="block text-[0.8125rem] text-muted">{t('rest.seatsN', { n: tb.seats })}</span>
                        </span>
                        <RowAction icon url={`/api/v1/restaurant-tables/${tb.id}/archive`} label={t('rest.archiveTable', { name: tb.code })} confirmText={t('rest.archiveConfirm', { name: tb.code })} />
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap items-start gap-2">
                  <TableForm areaId={a.id} />
                  {a.tables.length > 0 && <EditTablesForm tables={a.tables} />}
                </div>
              </Note>
            ))}
          </div>
        ) : (
          <Note><Empty>{areas ? t('rest.noAreas') : t('common.noAccess')}</Empty></Note>
        )}
      </section>
    </RestaurantChrome>
  );
}
