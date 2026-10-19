import { notFound, redirect } from 'next/navigation';
import { apiOrNull } from '@/lib/api';
import { isUuid } from '@/lib/options';

/** A supplier payment has no page of its own: the journal's link opens the invoice it settles. */
export default async function SupplierPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const payment = await apiOrNull<{ supplierInvoiceId: string }>(`/supplier-payments/${id}`);
  if (!payment) notFound();
  redirect(`/purchasing/invoices/${payment.supplierInvoiceId}`);
}
