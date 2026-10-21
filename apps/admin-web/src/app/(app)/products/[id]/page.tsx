import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionButton } from '@/components/actions';
import { Callout, Note, Serial } from '@/components/note';
import { allProducts, api, apiOrNull, type Category, type CurrentPrice, type Me, type PackageItems, type PackLink, type PriceList, type ProductDetail, type TaxCategory, type Uom } from '@/lib/api';
import { servesAppointments, servesLaundry, servesPharmacy } from '@/lib/business-type';
import { genericLabel } from '@/lib/pharmacy';
import { DrugBadge } from '../drug-fields';
import { peso } from '@/lib/format';
import { isUuid, variantOptions } from '@/lib/options';
import { categoryOptions } from '@/lib/categories';
import { getT } from '@/i18n/server';
import { AddCombinations } from '../variant-grid';
import { AddBarcode, AddPackLink, AddVariant, EditProduct, EditVariant, MakeBarcode, PackageContents, RemoveBarcode } from './forms';
import { pageTitle } from '@/i18n/page-title';

export const generateMetadata = pageTitle('products.item');

/** One product and its variants: details, barcodes, reference cost and the default price, with edit and archive. */
export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { t } = await getT();
  const [me, product, taxes, uoms, lists, links, cats] = await Promise.all([
    api<Me>('/me'),
    apiOrNull<ProductDetail>(`/products/${id}`),
    apiOrNull<{ data: TaxCategory[] }>('/tax-categories'),
    apiOrNull<{ data: Uom[] }>('/uoms'),
    apiOrNull<{ data: PriceList[] }>('/price-lists'),
    apiOrNull<{ data: PackLink[] }>('/pack-conversions'),
    apiOrNull<{ data: Category[] }>('/categories'),
  ]);
  if (!product) notFound();
  const defaultList = lists?.data.find((l) => l.isDefault);
  const prices = defaultList ? await apiOrNull<{ data: CurrentPrice[] }>(`/price-lists/${defaultList.id}/prices`) : null;
  const priceOf = new Map(prices?.data.map((p) => [p.variantId, p.amount]));
  const canManage = (me.activeTenant?.permissions.includes('catalog.manage') ?? false) && !product.archivedAt;
  const tax = taxes?.data.find((x) => x.id === product.taxCategoryId);
  const uom = uoms?.data.find((u) => u.id === product.uomId);
  const catOptions = categoryOptions(cats?.data);
  const categoryLabel = product.categoryId ? (catOptions.find((o) => o.id === product.categoryId)?.label ?? cats?.data.find((c) => c.id === product.categoryId)?.name) : null;
  const live = product.variants.filter((v) => !v.archivedAt);
  // Packs and pieces (ADR-0020): links where one of this product's items is the pack or the piece.
  const mine = new Set(product.variants.map((v) => v.id));
  const packLinks = (links?.data ?? []).filter((l) => mine.has(l.pack.variantId) || mine.has(l.piece.variantId));
  const stocked = product.trackInventory && canManage ? variantOptions((await allProducts())?.data, { stocked: true }) : [];
  // Salons (ADR-0022): a service's duration and supplies used; a package's validity and contents.
  const salon = servesAppointments(me.activeTenant?.businessType);
  // Laundries (ADR-0024 §2, §7, §11): how a job counts a service, add-ons, machine cycles, supplies used per load.
  const laundry = servesLaundry(me.activeTenant?.businessType);
  const supplies = salon || laundry;
  const isPackage = product.productType === 'PACKAGE';
  const contents = isPackage ? await Promise.all(live.map((v) => apiOrNull<PackageItems>(`/variants/${v.id}/package-items`))) : [];
  const serviceOptions = isPackage && canManage
    ? ((await allProducts())?.data ?? [])
        .filter((p) => p.productType === 'SERVICE' && !p.archivedAt)
        .flatMap((p) => p.variants.filter((v) => !v.archivedAt).map((v) => ({ id: v.id, label: `${v.sku} · ${p.name}${v.name ? ` — ${v.name}` : ''}` })))
    : [];
  const kindLabel = product.productType === 'SERVICE' ? t('prod.service') : isPackage ? t('prod.package') : product.trackInventory ? t('prod.tracked') : t('prod.untracked');

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link href="/products" className="text-[0.875rem] text-muted underline">{t('prod.title')}</Link>
        <h1 className="mt-1 text-[1.75rem] font-bold leading-tight tracking-[-0.01em]">{product.name}</h1>
        <Serial className="mt-1 block">
          {uom?.code ?? '—'} · {product.soldBy === 'WEIGHT' ? t('prod.byWeight') : t('prod.byUnit')} · {tax?.name ?? '—'} · {kindLabel}
          {product.tracksExpiry && <> · {t('prod.expiryTag')}</>}
          {' · '}<span data-testid="product-category">{categoryLabel ?? t('prod.noCategory')}</span>
        </Serial>
        {product.drugClass && (
          <p className="mt-2 flex flex-wrap items-center gap-2 text-[0.9375rem]" data-testid="drug-line">
            <DrugBadge drugClass={product.drugClass} />
            <span>{genericLabel(t, product)}</span>
            {product.fdaRegistrationNo && <Serial>{t('drug.fdaShort', { no: product.fdaRegistrationNo })}</Serial>}
          </p>
        )}
        {product.description && <p className="mt-2 max-w-[68ch] text-muted">{product.description}</p>}
      </div>

      {product.archivedAt && <Callout>{t('prod.archivedNote')}</Callout>}

      {canManage && taxes && (
        <div className="flex flex-wrap items-start gap-2">
          <EditProduct product={product} taxes={taxes.data} categories={catOptions} pharmacy={servesPharmacy(me.activeTenant?.businessType)} />
          <AddVariant productId={product.id} />
          <AddCombinations product={product} />
          <ActionButton url={`/api/v1/products/${product.id}/archive`} label={t('prod.archive')} confirmText={t('prod.archiveConfirm', { name: product.name })} />
        </div>
      )}

      <section>
        <h2 className="section-title mb-3">{t('prod.variantsTitle')}</h2>
        <div className="flex flex-col gap-3">
          {product.variants.map((v) => (
            <Note key={v.id} denom="blue" className={`flex flex-col gap-3 px-4 py-3 pr-6 ${v.archivedAt ? 'opacity-60' : ''}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold">{v.name ?? product.name}{v.archivedAt && <span className="tag ml-2">{t('prod.archived')}</span>}</p>
                  <Serial className="text-ink">{v.sku}</Serial>
                  {(Object.keys(v.attributes ?? {}).length > 0 || v.quickKeyPosition || product.productType === 'SERVICE' || isPackage || v.laundryAddon || v.laundryUnit) && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {product.productType === 'SERVICE' && (salon || !laundry) && <span className="tag" data-testid="duration">{v.serviceMinutes ? t('prod.durationTag', { n: v.serviceMinutes }) : t('prod.noDuration')}</span>}
                      {v.laundryUnit && <span className="tag border-blue/40 text-blue!" data-testid="laundry-unit">{t(`prod.laundryTag.${v.laundryUnit}`)}{v.laundryMinQuantity && ` · ${t('prod.laundryMinTag', { n: v.laundryMinQuantity })}`}{v.laundryKgPerLoad && ` · ${t('prod.laundryLoadTag', { n: v.laundryKgPerLoad })}`}</span>}
                      {v.laundryAddon && <span className="tag">{t('prod.laundryAddonTag')}</span>}
                      {v.machineKind && <span className="tag" data-testid="machine-cycle">{t(`lau.kind.${v.machineKind}`)} · {t('lau.minutesN', { n: v.machineMinutes ?? 0 })}</span>}
                      {isPackage && <span className="tag">{v.packageValidDays ? t('prod.validTag', { n: v.packageValidDays }) : t('prod.noExpiry')}</span>}
                      {Object.entries(v.attributes ?? {}).map(([k, val]) => <span key={k} className="tag">{k}: {val}</span>)}
                      {v.quickKeyPosition && <span className="tag border-blue/40 text-blue!">{t('qk.keyN', { n: v.quickKeyPosition })}</span>}
                    </div>
                  )}
                </div>
                <dl className="flex gap-6 text-right">
                  <div>
                    <dt className="text-[0.75rem] text-muted">{t('price.current')}</dt>
                    <dd className="money font-semibold">{peso(priceOf.get(v.id))}</dd>
                  </div>
                  <div>
                    <dt className="text-[0.75rem] text-muted">{t('prod.refCost')}</dt>
                    <dd className="money">{peso(v.referenceCost)}</dd>
                  </div>
                </dl>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[0.8125rem] text-muted">{t('prod.barcodeCol')}:</span>
                {v.barcodeIds.length === 0 && <span className="text-[0.8125rem] text-muted">—</span>}
                {v.barcodeIds.map((b) => (canManage && !v.archivedAt ? <RemoveBarcode key={b.id} barcode={b} /> : <span key={b.id} className="tag serial">{b.code}</span>))}
              </div>
              {canManage && !v.archivedAt && (
                <div className="flex flex-wrap items-end gap-3">
                  <AddBarcode variantId={v.id} />
                  {v.barcodeIds.length === 0 && <MakeBarcode variantId={v.id} />}
                  <EditVariant variant={v} productType={product.productType} laundry={laundry} />
                  {product.productType === 'SERVICE' && supplies && (
                    <Link href={`/products/${product.id}/supplies/${v.id}`} className="btn">{t('prod.suppliesUsed')}</Link>
                  )}
                  {live.length > 1 && (
                    <ActionButton url={`/api/v1/variants/${v.id}/archive`} label={t('prod.archiveVariant')} confirmText={t('prod.archiveVariantConfirm', { sku: v.sku })} />
                  )}
                </div>
              )}
              {isPackage && !v.archivedAt && (
                <div className="border-t border-hair-soft pt-3">
                  <p className="mb-2 text-[0.875rem] font-semibold">{t('prod.pkgContents')}</p>
                  {canManage ? (
                    <PackageContents variantId={v.id} services={serviceOptions} items={contents[live.indexOf(v)]?.items ?? []} />
                  ) : (contents[live.indexOf(v)]?.items.length ?? 0) > 0 ? (
                    <ul className="grid gap-0.5 text-[0.9375rem]">
                      {contents[live.indexOf(v)]!.items.map((i) => <li key={i.serviceVariantId}>{t('prod.pkgLine', { n: i.sessions, name: i.name })}</li>)}
                    </ul>
                  ) : (
                    <p className="text-[0.875rem] text-muted">{t('prod.pkgEmpty')}</p>
                  )}
                </div>
              )}
            </Note>
          ))}
        </div>
        {canManage && <p className="mt-2 text-[0.8125rem] text-muted">{t('prod.priceHint')} <Link href="/prices" className="underline">{t('price.title')}</Link></p>}
      </section>

      {product.trackInventory && (
        <section aria-labelledby="packs-title">
          <h2 id="packs-title" className="section-title mb-1">{t('prod.packsTitle')}</h2>
          <p className="mb-3 max-w-[68ch] text-[0.875rem] text-muted">{t('prod.packsLede')}</p>
          {packLinks.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {packLinks.map((l) => (
                <li key={l.id}>
                  <Note denom="blue" className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 pr-6">
                    <div className="min-w-0">
                      <p className="font-semibold">{t('prod.packLine', { pack: l.pack.name, n: l.piecesPerPack, piece: l.piece.name })}</p>
                      <Serial>
                        {l.pack.sku} → {l.piece.sku} · {l.autoOpen ? t('prod.autoOpenOn') : t('prod.autoOpenOff')}
                      </Serial>
                    </div>
                    {canManage && (
                      <div className="flex flex-wrap gap-2">
                        <ActionButton method="PATCH" url={`/api/v1/pack-conversions/${l.id}`} body={{ autoOpen: !l.autoOpen }} label={l.autoOpen ? t('prod.autoOpenTurnOff') : t('prod.autoOpenTurnOn')} />
                        <ActionButton url={`/api/v1/pack-conversions/${l.id}/archive`} label={t('prod.packArchive')} confirmText={t('prod.packArchiveConfirm', { pack: l.pack.name, piece: l.piece.name })} />
                      </div>
                    )}
                  </Note>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.875rem] text-muted">{t('prod.noPacks')}</p>
          )}
          {canManage && stocked.length > 1 && (
            <div className="mt-3">
              <AddPackLink variants={stocked} packVariantId={live[0]?.id} />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
