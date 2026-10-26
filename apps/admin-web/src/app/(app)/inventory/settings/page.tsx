import { Empty, Note } from '@/components/note';
import { api, apiOrNull, type InventorySettings, type Me, type StockInUse } from '@/lib/api';
import { getT } from '@/i18n/server';
import { InventoryChrome, inventoryBranch } from '../chrome';
import { InventorySettingsForm } from '../sheets';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('inventory.settings');

export default async function InventorySettingsPage({ searchParams }: { searchParams: Promise<{ branch?: string }> }) {
  const { t } = await getT();
  const { branches, branch } = await inventoryBranch((await searchParams).branch);
  const [me, settings, inUse] = await Promise.all([
    api<Me>('/me'),
    branch ? apiOrNull<InventorySettings>(`/branches/${branch.id}/inventory-settings`) : null,
    apiOrNull<StockInUse>('/stock/in-use'),
  ]);
  const canEdit = me.activeTenant?.permissions.includes('org.manage') ?? false;
  return (
    <InventoryChrome tab="settings" branches={branches} branch={branch}>
      <section className="max-w-[720px]">
        <h2 className="section-title mb-1 pt-2">{t('invset.title')}</h2>
        <p className="mb-4 text-[0.875rem] text-muted">{t('invset.lede')}</p>
        <Note denom="gold" className="px-5 py-5 pr-8">
          {settings ? <InventorySettingsForm key={settings.branchId} settings={settings} canEdit={canEdit} dated={inUse?.expiry ?? true} /> : <Empty>{t('common.noAccess')}</Empty>}
        </Note>
      </section>
    </InventoryChrome>
  );
}
