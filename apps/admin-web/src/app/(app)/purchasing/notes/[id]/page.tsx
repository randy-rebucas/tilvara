import { notFound, redirect } from 'next/navigation';
import { apiOrNull } from '@/lib/api';
import { isUuid } from '@/lib/options';

/** A supplier credit or debit note has no page of its own: the journal's link opens the invoice it adjusts. */
export default async function SupplierNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const note = await apiOrNull<{ supplierInvoiceId: string }>(`/supplier-notes/${id}`);
  if (!note) notFound();
  redirect(`/purchasing/invoices/${note.supplierInvoiceId}`);
}
