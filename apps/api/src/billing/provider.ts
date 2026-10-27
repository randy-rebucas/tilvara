import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { toDec } from '@1pos/money';

/**
 * Port for whoever takes the businesses' subscription payments (ADR-0027). Never called inside a
 * database transaction. The provider hosts the payment page: Tilvara never sees card or wallet details.
 */
export interface CheckoutRequest {
  billId: string;
  /** The bill's number, shown on the provider's page and its receipt (B-000001). */
  number: string;
  description: string;
  /** Decimal string, e.g. "999.00". */
  amount: string;
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

export interface OpenedCheckout {
  provider: 'PAYMONGO' | 'DEV';
  checkoutId: string;
  url: string;
  expiresAt: Date;
}

/** A provider event whose signature was checked; `paid` is null for events that pay nothing. */
export interface BillingWebhookEvent {
  eventId: string;
  type: string;
  checkoutId: string | null;
  paid: { reference: string; amount: string; currency: string; method: string } | null;
}

export abstract class BillingProvider {
  abstract readonly code: 'PAYMONGO' | 'DEV';
  abstract openCheckout(req: CheckoutRequest, signal: AbortSignal): Promise<OpenedCheckout>;
}

/** A checkout page lasts a day at the provider; ours is reused for 23 hours, then a new one is opened. */
const CHECKOUT_REUSE_MS = 23 * 3_600_000;

/** Centavos (PayMongo's integer amounts) ↔ decimal strings, without JS number arithmetic. */
export const toCentavos = (amount: string) => toDec(amount).times(100).toFixed(0);
export const fromCentavos = (centavos: string | number) => toDec(String(centavos)).dividedBy(100).toFixed(2);

const METHOD_BY_SOURCE: Record<string, string> = {
  card: 'CARD',
  gcash: 'GCASH',
  paymaya: 'MAYA',
  grab_pay: 'GRABPAY',
  qrph: 'QRPH',
  dob: 'BANK_TRANSFER',
  dob_ubp: 'BANK_TRANSFER',
};

/**
 * PayMongo checkout sessions (https://developers.paymongo.com, Checkout API). The bill is paid when the
 * signed `checkout_session.payment.paid` webhook arrives; the redirect back only shows "processing".
 */
export class PayMongoBillingProvider extends BillingProvider {
  readonly code = 'PAYMONGO' as const;

  constructor(
    private readonly secretKey: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly baseUrl = 'https://api.paymongo.com/v1',
  ) {
    super();
  }

  async openCheckout(req: CheckoutRequest, signal: AbortSignal): Promise<OpenedCheckout> {
    const res = await this.fetchFn(`${this.baseUrl}/checkout_sessions`, {
      method: 'POST',
      signal,
      headers: {
        authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        data: {
          attributes: {
            line_items: [{ amount: Number(toCentavos(req.amount)), currency: req.currency, name: req.description, quantity: 1 }],
            payment_method_types: ['card', 'gcash', 'paymaya', 'grab_pay', 'qrph'],
            description: req.description,
            reference_number: req.number,
            success_url: req.successUrl,
            cancel_url: req.cancelUrl,
            send_email_receipt: false,
            show_description: true,
            show_line_items: true,
            // Ids only: the payload is the provider's to keep.
            metadata: { bill_id: req.billId, bill_number: req.number },
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`PayMongo answered ${res.status} to a checkout session`);
    const body = (await res.json()) as { data?: { id?: string; attributes?: { checkout_url?: string } } };
    const id = body.data?.id;
    const url = body.data?.attributes?.checkout_url;
    if (!id || !url || !url.startsWith('https://')) throw new Error('PayMongo sent no checkout session id or https address');
    return { provider: 'PAYMONGO', checkoutId: id, url, expiresAt: new Date(Date.now() + CHECKOUT_REUSE_MS) };
  }
}

/** Seconds a PayMongo signature's timestamp may be off from now (replays older than this are refused). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * `Paymongo-Signature: t=<unix>,te=<hex>,li=<hex>`: HMAC-SHA256 of `<t>.<raw body>` with the webhook's
 * secret; `te` for test-mode events, `li` for live ones. True only for a fresh, matching signature.
 */
export function verifyPayMongoSignature(header: string | undefined, rawBody: Buffer, secret: string, live: boolean, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = parts.t;
  const given = live ? parts.li : parts.te;
  if (!t || !/^\d{1,12}$/.test(t) || !given || !/^[0-9a-f]{64}$/i.test(given)) return false;
  if (Math.abs(nowSeconds - Number(t)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  const actual = Buffer.from(given, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Whether a PayMongo event body says it is live, read before the signature to pick `li` or `te`. */
export function payMongoLivemode(rawBody: Buffer): boolean {
  try {
    return (JSON.parse(rawBody.toString('utf8')) as { data?: { attributes?: { livemode?: boolean } } }).data?.attributes?.livemode === true;
  } catch {
    return false;
  }
}

/** Whether a PayMongo secret key is a live one (`sk_live_…`); a test key only ever sees test events. */
export const payMongoKeyIsLive = (secretKey: string | undefined) => !!secretKey?.startsWith('sk_live_');

/**
 * A webhook is accepted only in the mode of the configured secret key (audit 45 #16): a live key takes
 * live events signed `li`, a test key test events signed `te`. The body's `livemode` is unverified until
 * the signature checks, so it is compared with the key's mode, never trusted to pick the mode.
 */
export function verifyPayMongoWebhook(header: string | undefined, rawBody: Buffer, webhookSecret: string, secretKey: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const live = payMongoKeyIsLive(secretKey);
  if (payMongoLivemode(rawBody) !== live) return false;
  return verifyPayMongoSignature(header, rawBody, webhookSecret, live, nowSeconds);
}

interface PayMongoPayment {
  id?: string;
  attributes?: { amount?: number | string; currency?: string; status?: string; source?: { type?: string } };
}

/** The parts of a (signature-checked) PayMongo event Tilvara uses; null when it is not an event at all. */
export function parsePayMongoEvent(rawBody: Buffer): BillingWebhookEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  const event = (body as { data?: { id?: unknown; attributes?: { type?: unknown; data?: unknown } } }).data;
  if (!event || typeof event.id !== 'string' || typeof event.attributes?.type !== 'string') return null;
  const resource = event.attributes.data as { id?: unknown; type?: unknown; attributes?: { payments?: PayMongoPayment[] } } | undefined;
  const checkoutId = resource?.type === 'checkout_session' && typeof resource.id === 'string' ? resource.id : null;
  let paid: BillingWebhookEvent['paid'] = null;
  if (event.attributes.type === 'checkout_session.payment.paid') {
    const p = (resource?.attributes?.payments ?? []).find((x) => x.attributes?.status === 'paid');
    const amount = p?.attributes?.amount;
    if (p?.id && ((typeof amount === 'number' && Number.isSafeInteger(amount) && amount > 0) || (typeof amount === 'string' && /^\d+$/.test(amount))) && typeof p.attributes?.currency === 'string') {
      paid = {
        reference: p.id,
        amount: fromCentavos(amount),
        currency: p.attributes.currency.toUpperCase(),
        method: METHOD_BY_SOURCE[p.attributes.source?.type ?? ''] ?? 'OTHER',
      };
    }
  }
  return { eventId: event.id, type: event.attributes.type, checkoutId, paid };
}

/**
 * Development simulator, refused in production by @1pos/config: its checkout page (served by this API,
 * `GET /v1/billing/dev-checkout?id=…`) pays the bill on a click, through the same path as a PayMongo
 * webhook. Pages live in this process only.
 */
export class DevBillingProvider extends BillingProvider {
  readonly code = 'DEV' as const;
  private readonly pages = new Map<string, { number: string; amount: string; currency: string; successUrl: string; cancelUrl: string }>();

  constructor(private readonly apiPublicUrl: string) {
    super();
  }

  async openCheckout(req: CheckoutRequest): Promise<OpenedCheckout> {
    const checkoutId = `dev_cs_${randomUUID().replace(/-/g, '')}`;
    this.pages.set(checkoutId, { number: req.number, amount: req.amount, currency: req.currency, successUrl: req.successUrl, cancelUrl: req.cancelUrl });
    return { provider: 'DEV', checkoutId, url: `${this.apiPublicUrl.replace(/\/$/, '')}/v1/billing/dev-checkout?id=${checkoutId}`, expiresAt: new Date(Date.now() + CHECKOUT_REUSE_MS) };
  }

  page(checkoutId: string) {
    return this.pages.get(checkoutId) ?? null;
  }

  /** The event a paid dev checkout produces, shaped like a PayMongo one. */
  paidEvent(checkoutId: string, method: string): BillingWebhookEvent | null {
    const p = this.pages.get(checkoutId);
    if (!p) return null;
    return {
      eventId: `dev_evt_${randomUUID().replace(/-/g, '')}`,
      type: 'checkout_session.payment.paid',
      checkoutId,
      paid: { reference: `dev_pay_${checkoutId.slice(7)}`, amount: p.amount, currency: p.currency, method },
    };
  }
}
