import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { assertStorableResponse, completeIdempotency, IDEMPOTENT } from '../../src/infrastructure/idempotency.js';
import { IntegrationsController } from '../../src/integrations/integrations.controller.js';
import { OrgController } from '../../src/org/org.controller.js';

/** Audit 47 #3: an answer holding a secret is never stored in idempotency_records for replay. */
describe('idempotent answers never hold a secret', () => {
  it('refuses an answer with a key, secret, credential or token field', () => {
    for (const field of ['key', 'secret', 'credential', 'token', 'recoveryCodes']) {
      expect(() => assertStorableResponse({ id: 'x', [field]: 'tlv_abc' })).toThrow(/secret field/);
    }
    expect(() => assertStorableResponse({ id: 'x', name: 'Key 1', prefix: 'abc' })).not.toThrow();
    expect(() => assertStorableResponse([{ key: 'row' }])).not.toThrow();
    expect(() => assertStorableResponse(undefined)).not.toThrow();
  });

  it('completeIdempotency stores nothing for such an answer', async () => {
    let wrote = false;
    const db = { update: () => ((wrote = true), { set: () => ({ where: async () => undefined }) }) };
    const ctx = { scope: 'POST /v1/api-keys', key: 'k', requestHash: 'h', userId: 'u', responseStatus: 201, consumed: true };
    await expect(completeIdempotency(db as never, ctx, { id: '1', key: 'tlv_x' })).rejects.toThrow(/secret field/);
    expect(wrote).toBe(false);
  });

  it('creating an API key, a webhook (and its secret rotation) or a terminal is not @Idempotent', () => {
    const handlers = [
      IntegrationsController.prototype.createKey,
      IntegrationsController.prototype.createWebhook,
      IntegrationsController.prototype.rotate,
      OrgController.prototype.registerTerminal,
    ];
    for (const h of handlers) expect(Reflect.getMetadata(IDEMPOTENT, h)).toBeUndefined();
  });
});
