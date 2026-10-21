import { Callout, Note } from '@/components/note';
import { allProducts, apiOrNull, type GarmentType } from '@/lib/api';
import { getT } from '@/i18n/server';
import { LaundryChrome, laundryAccess, laundryBranch } from '../chrome';
import { JobOrderForm, type LaundryOption } from './job-form';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('laundry.new');

/** Take in laundry (ADR-0024 §3): the services are the catalogue's laundry items and add-ons. */
export default async function NewJobOrderPage({ searchParams }: { searchParams: Promise<{ branch?: string }> }) {
  const sp = await searchParams;
  const { t } = await getT();
  const { branches, branch } = await laundryBranch(sp.branch);
  const { canManage, canCustomers } = await laundryAccess();
  const [products, garments] = branch ? await Promise.all([allProducts(), apiOrNull<{ data: GarmentType[] }>('/laundry/garment-types')]) : [null, null];
  const services: LaundryOption[] = (products?.data ?? [])
    .filter((p) => !p.archivedAt)
    .flatMap((p) =>
      p.variants
        .filter((v) => !v.archivedAt && (v.laundryUnit || v.laundryAddon))
        .map((v) => ({
          variantId: v.id,
          label: `${p.name}${v.name ? ` — ${v.name}` : ''}`,
          unit: v.laundryUnit ?? null,
          min: v.laundryMinQuantity ?? null,
          kgPerLoad: v.laundryKgPerLoad ?? null,
          addon: v.laundryAddon ?? false,
        })),
    );

  return (
    <LaundryChrome tab="board" branches={branches} branch={branch}>
      <h2 className="text-[1.0625rem] font-semibold">{t('lau.newJob')}</h2>
      {!canManage ? (
        <Callout>{t('lau.cannotTakeIn')}</Callout>
      ) : (
        <Note className="px-5 py-5 pr-8">
          <JobOrderForm branchId={branch!.id} services={services} garmentTypes={(garments?.data ?? []).filter((g) => !g.archivedAt)} canSearchCustomers={canCustomers} />
        </Note>
      )}
    </LaundryChrome>
  );
}
