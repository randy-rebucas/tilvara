import { HttpStatus } from '@nestjs/common';
import { inArray, priceOverrides, saleLines, type Database } from '@1pos/database';
import type { AuthContext } from '../auth/auth-context.js';
import { toDec } from '@1pos/money';
import { AppError } from '../infrastructure/http-error.filter.js';

const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new AppError(code, message, HttpStatus.UNPROCESSABLE_ENTITY, details);

/** Approved prices for these cart lines, checked for the cashier asking now (shared by quote and checkout). */
export async function overridesForCart(
  db: Database,
  auth: AuthContext,
  branchId: string,
  at: Date,
  lines: readonly { variantId: string; quantity: string; priceOverrideId?: string | undefined; id?: string | undefined }[],
) {
  const ids = [...new Set(lines.flatMap((l) => (l.priceOverrideId ? [l.priceOverrideId] : [])))];
  const out = new Map<string, typeof priceOverrides.$inferSelect>();
  if (!ids.length) return out;
  if (ids.length !== lines.filter((l) => l.priceOverrideId).length) throw unprocessable('PRICE_OVERRIDE_REPEATED', 'An approved price is for one line');
  const rows = await db.select().from(priceOverrides).where(inArray(priceOverrides.id, ids));
  for (const [index, l] of lines.entries()) {
    if (!l.priceOverrideId) continue;
    const line = l.id ?? String(index + 1);
    const o = rows.find((r) => r.id === l.priceOverrideId);
    if (!o) throw new AppError('NOT_FOUND', 'Price approval not found', HttpStatus.NOT_FOUND, { line });
    if (o.branchId !== branchId || o.variantId !== l.variantId) throw unprocessable('PRICE_OVERRIDE_MISMATCH', 'This price was approved for another item or branch', { line });
    if (o.requestedBy !== auth.userId) {
      // A held cart resumed by someone else keeps its lines, not the approval: that was given to the cashier who asked.
      throw unprocessable('PRICE_OVERRIDE_MISMATCH', 'This price change was approved for the cashier who asked for it; ask for the approval again', { line, reason: 'OTHER_CASHIER' });
    }
    if (o.expiresAt.getTime() <= at.getTime()) throw unprocessable('PRICE_OVERRIDE_EXPIRED', 'The approval for this price has expired; ask again', { line });
    if (o.quantity !== null && toDec(l.quantity).gt(o.quantity)) {
      throw unprocessable('PRICE_OVERRIDE_QUANTITY', `This price was approved for ${toDec(o.quantity).toString()}; ask again for more`, { line, approvedQuantity: toDec(o.quantity).toString() });
    }
    out.set(o.id, o);
  }
  // An approval prices one sale line (the unique index is the backstop at checkout).
  const used = await db.select({ id: saleLines.priceOverrideId }).from(saleLines).where(inArray(saleLines.priceOverrideId, ids)).limit(1);
  if (used.length) throw new AppError('PRICE_OVERRIDE_USED', 'This approved price was already used on a sale', HttpStatus.CONFLICT, { priceOverrideId: used[0]!.id });
  return out;
}
