import { notFound, redirect } from 'next/navigation';
import { apiOrNull } from '@/lib/api';
import { isUuid } from '@/lib/options';

/** A pay-in or pay-out is shown inside its shift: journal entries link here by the movement's own id. */
export default async function CashMovementRedirect({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const movement = await apiOrNull<{ id: string; cashierSessionId: string }>(`/cash-movements/${id}`);
  if (!movement) notFound();
  redirect(`/shifts/${movement.cashierSessionId}#movement-${movement.id}`);
}
