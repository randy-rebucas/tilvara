import { HttpStatus } from '@nestjs/common';
import { eq, paymentEvents, paymentIntents, type Database } from '@1pos/database';
import type { AuthContext } from '../auth/auth-context.js';
import { hasPermission } from '../auth/authorization.js';
import { tenantOf } from '../auth/auth-context.js';
import { AppError } from '../infrastructure/http-error.filter.js';
import { loadSession } from '../sales/cash.service.js';
import { unprocessable } from '../tax/tax.service.js';

const forbidden = (perm: string) => new AppError('FORBIDDEN', 'You do not have permission to do this', HttpStatus.FORBIDDEN, { missing: [perm] });

/**
 * The drawer the front desk takes money with (ADR-0023 §5.2): an open cashier session of the folio's
 * legal entity (any of its branches), the person's own unless they reconcile drawers there.
 */
export async function frontDeskSession(db: Database, auth: AuthContext, sessionId: string, legalEntityId: string) {
  const { session, scope } = await loadSession(db, sessionId, true);
  const grants = tenantOf(auth).grants;
  if (!hasPermission(grants, 'cash.session', scope) && !hasPermission(grants, 'cash.reconcile', scope)) throw forbidden('cash.session');
  if (session.status !== 'OPEN') throw new AppError('SESSION_NOT_OPEN', 'This cashier session is not open', HttpStatus.CONFLICT);
  if (session.openedBy !== auth.userId && !hasPermission(grants, 'cash.reconcile', scope)) {
    throw new AppError('NOT_SESSION_OWNER', 'Take payments on your own cashier session', HttpStatus.FORBIDDEN);
  }
  if (scope.legalEntityId !== legalEntityId) throw unprocessable('WRONG_ENTITY', 'Take this guest\'s money at a drawer of the same legal entity');
  return { session, scope };
}

/**
 * A card/QR payment of purpose FOLIO taken at this drawer, consumed once by a folio payment or a deposit:
 * locked, succeeded, of this shift, not consumed; marked with the folio it paid.
 */
export async function consumeFolioIntent(db: Database, auth: AuthContext, a: { paymentIntentId: string; sessionId: string; folioId: string; currency: string; consumer: Record<string, unknown> }) {
  const [p] = await db.select().from(paymentIntents).where(eq(paymentIntents.id, a.paymentIntentId)).for('update');
  if (!p) throw new AppError('NOT_FOUND', 'Payment not found', HttpStatus.NOT_FOUND, { paymentIntentId: a.paymentIntentId });
  if (p.saleId || p.folioId) throw new AppError('PAYMENT_CONSUMED', 'This payment was already used', HttpStatus.CONFLICT, { paymentIntentId: p.id });
  if (p.status !== 'SUCCEEDED') throw new AppError('PAYMENT_NOT_SUCCEEDED', `This payment is ${p.status.toLowerCase()}`, HttpStatus.CONFLICT, { paymentIntentId: p.id, status: p.status });
  if (p.purpose !== 'FOLIO') throw unprocessable('PAYMENT_MISMATCH', 'This payment was taken for a sale, not a folio', { paymentIntentId: p.id });
  if (p.cashierSessionId !== a.sessionId || p.currency !== a.currency) throw unprocessable('PAYMENT_MISMATCH', 'This payment was taken at another drawer', { paymentIntentId: p.id });
  await db.update(paymentIntents).set({ folioId: a.folioId }).where(eq(paymentIntents.id, p.id));
  await db.insert(paymentEvents).values({ tenantId: tenantOf(auth).tenantId, paymentIntentId: p.id, type: 'CONSUMED', detail: { folioId: a.folioId, ...a.consumer }, createdBy: auth.userId });
  return p;
}
