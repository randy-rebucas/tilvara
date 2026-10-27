import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fromCentavos, parsePayMongoEvent, PayMongoBillingProvider, payMongoLivemode, toCentavos, verifyPayMongoSignature, verifyPayMongoWebhook } from '../../src/billing/provider.js';

const SECRET = 'whsk_test_secret';
const NOW = 1_800_000_000;
const sign = (t: number, body: string, secret = SECRET) => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

describe('PayMongo webhook signature (ADR-0027)', () => {
  const body = Buffer.from('{"data":{"id":"evt_1","attributes":{"type":"checkout_session.payment.paid","livemode":false}}}');

  it('accepts a fresh test-mode signature over the exact bytes', () => {
    expect(verifyPayMongoSignature(`t=${NOW},te=${sign(NOW, body.toString())},li=`, body, SECRET, false, NOW)).toBe(true);
  });

  it('refuses another secret, other bytes, a stale or future timestamp, the wrong mode, and junk', () => {
    const good = sign(NOW, body.toString());
    expect(verifyPayMongoSignature(`t=${NOW},te=${sign(NOW, body.toString(), 'whsk_other')}`, body, SECRET, false, NOW)).toBe(false);
    expect(verifyPayMongoSignature(`t=${NOW},te=${good}`, Buffer.from(`${body.toString()} `), SECRET, false, NOW)).toBe(false);
    expect(verifyPayMongoSignature(`t=${NOW - 301},te=${sign(NOW - 301, body.toString())}`, body, SECRET, false, NOW)).toBe(false);
    expect(verifyPayMongoSignature(`t=${NOW + 301},te=${sign(NOW + 301, body.toString())}`, body, SECRET, false, NOW)).toBe(false);
    // A live event is checked against `li`; a test signature does not pass for it.
    expect(verifyPayMongoSignature(`t=${NOW},te=${good},li=`, body, SECRET, true, NOW)).toBe(false);
    expect(verifyPayMongoSignature(`t=${NOW},li=${good}`, body, SECRET, true, NOW)).toBe(true);
    for (const h of [undefined, '', 'garbage', `t=abc,te=${good}`, `te=${good}`, `t=${NOW},te=zz`]) {
      expect(verifyPayMongoSignature(h, body, SECRET, false, NOW)).toBe(false);
    }
    expect(verifyPayMongoSignature(`t=${NOW},te=${good}`, body, '', false, NOW)).toBe(false);
  });

  it('takes only events in the mode of the configured secret key (audit 45 #16)', () => {
    const liveBody = Buffer.from('{"data":{"id":"evt_2","attributes":{"type":"checkout_session.payment.paid","livemode":true}}}');
    const testSig = `t=${NOW},te=${sign(NOW, body.toString())}`;
    const liveSig = `t=${NOW},li=${sign(NOW, liveBody.toString())}`;
    expect(verifyPayMongoWebhook(testSig, body, SECRET, 'sk_test_abc', NOW)).toBe(true);
    expect(verifyPayMongoWebhook(liveSig, liveBody, SECRET, 'sk_live_abc', NOW)).toBe(true);
    // A test key never takes a live event, and a live key never a test one, however well signed.
    expect(verifyPayMongoWebhook(liveSig, liveBody, SECRET, 'sk_test_abc', NOW)).toBe(false);
    expect(verifyPayMongoWebhook(testSig, body, SECRET, 'sk_live_abc', NOW)).toBe(false);
    // A body claiming live but signed `te` (the old path read the mode from the body) is refused under a test key too.
    expect(verifyPayMongoWebhook(`t=${NOW},te=${sign(NOW, liveBody.toString())}`, liveBody, SECRET, 'sk_test_abc', NOW)).toBe(false);
    expect(verifyPayMongoWebhook(testSig, body, SECRET, undefined, NOW)).toBe(true);
  });

  it('reads livemode from the body, false when unreadable', () => {
    expect(payMongoLivemode(Buffer.from('{"data":{"attributes":{"livemode":true}}}'))).toBe(true);
    expect(payMongoLivemode(body)).toBe(false);
    expect(payMongoLivemode(Buffer.from('not json'))).toBe(false);
  });
});

describe('PayMongo events and amounts', () => {
  const paid = (payments: unknown[]) =>
    Buffer.from(JSON.stringify({
      data: { id: 'evt_9', type: 'event', attributes: { type: 'checkout_session.payment.paid', livemode: false, data: { id: 'cs_1', type: 'checkout_session', attributes: { payments } } } },
    }));

  it('takes the paid payment: centavos to a decimal string, the method in Tilvara’s words', () => {
    const e = parsePayMongoEvent(paid([
      { id: 'pay_fail', attributes: { amount: 149900, currency: 'PHP', status: 'failed', source: { type: 'card' } } },
      { id: 'pay_ok', attributes: { amount: 149950, currency: 'php', status: 'paid', source: { type: 'paymaya' } } },
    ]));
    expect(e).toEqual({ eventId: 'evt_9', type: 'checkout_session.payment.paid', checkoutId: 'cs_1', paid: { reference: 'pay_ok', amount: '1499.50', currency: 'PHP', method: 'MAYA' } });
  });

  it('pays nothing without a paid payment, for other events, and is null for what is not an event', () => {
    expect(parsePayMongoEvent(paid([]))!.paid).toBeNull();
    expect(parsePayMongoEvent(paid([{ id: 'p', attributes: { amount: 1.5, currency: 'PHP', status: 'paid' } }]))!.paid).toBeNull();
    expect(parsePayMongoEvent(Buffer.from('{"data":{"id":"evt_2","attributes":{"type":"payment.failed","data":{}}}}'))).toEqual({ eventId: 'evt_2', type: 'payment.failed', checkoutId: null, paid: null });
    expect(parsePayMongoEvent(Buffer.from('[]'))).toBeNull();
    expect(parsePayMongoEvent(Buffer.from('{'))).toBeNull();
  });

  it('converts amounts exactly', () => {
    expect(toCentavos('1499.0000')).toBe('149900');
    expect(toCentavos('0.10')).toBe('10');
    expect(fromCentavos(1)).toBe('0.01');
    expect(fromCentavos('99999999')).toBe('999999.99');
  });

  it('opens a checkout session with the bill’s number and amount in centavos, and only trusts an https address', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const reply = (body: unknown, status = 200) => async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return new Response(JSON.stringify(body), { status });
    };
    const pm = new PayMongoBillingProvider('sk_test_abc', reply({ data: { id: 'cs_9', attributes: { checkout_url: 'https://checkout.paymongo.com/cs_9' } } }) as typeof fetch);
    const req = { billId: 'b1', number: 'B-000007', description: 'Tilvara Growth plan, bill B-000007', amount: '1499.0000', currency: 'PHP', successUrl: 'https://app/s', cancelUrl: 'https://app/c' };
    const opened = await pm.openCheckout(req, AbortSignal.timeout(1000));
    expect(opened).toMatchObject({ provider: 'PAYMONGO', checkoutId: 'cs_9', url: 'https://checkout.paymongo.com/cs_9' });
    expect(calls[0]!.url).toBe('https://api.paymongo.com/v1/checkout_sessions');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('sk_test_abc:').toString('base64')}`);
    const sent = JSON.parse(String(calls[0]!.init.body)).data.attributes;
    expect(sent).toMatchObject({ reference_number: 'B-000007', line_items: [{ amount: 149900, currency: 'PHP', quantity: 1 }], metadata: { bill_id: 'b1', bill_number: 'B-000007' } });
    await expect(new PayMongoBillingProvider('sk_test_abc', reply({ data: { id: 'cs_9', attributes: { checkout_url: 'http://evil' } } }) as typeof fetch).openCheckout(req, AbortSignal.timeout(1000))).rejects.toThrow(/https/);
    await expect(new PayMongoBillingProvider('sk_test_abc', reply({ errors: [] }, 401) as typeof fetch).openCheckout(req, AbortSignal.timeout(1000))).rejects.toThrow(/401/);
  });
});
