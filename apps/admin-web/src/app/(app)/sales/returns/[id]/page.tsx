import { notFound, redirect } from 'next/navigation';
import { apiOrNull, type SaleReturnDoc } from '@/lib/api';
import { isUuid } from '@/lib/options';

/** A return or void is shown inside its sale: journal entries link here by the return's own id. */
export default async function SaleReturnRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const doc = await apiOrNull<SaleReturnDoc>(`/sale-returns/${id}`);
  if (!doc) notFound();
  redirect(`/sales/${doc.saleId}#return-${doc.id}`);
}
