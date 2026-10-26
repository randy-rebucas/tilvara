# Tilvara — API Conventions

- Base path: `/v1`. Breaking changes → `/v2`; additive changes stay in `v1`.
- JSON, `camelCase` fields. Money: `{ "amount": "123.45", "currency": "PHP" }` — amounts are **strings**. Quantities: strings.
- IDs: UUIDv7 strings. Timestamps: RFC 3339 UTC (`2026-10-15T03:12:00.000Z`); `businessDate` as `YYYY-MM-DD`.
- Tenant scope: from the access token's membership. URLs never carry a tenant id that is trusted for authorization.
- Auth: `Authorization: Bearer <access JWT>`; terminals additionally send `X-Terminal-Id` + signed terminal credential.
- Idempotency: mutating financial endpoints **require** `Idempotency-Key` (UUID). Same key + same request fingerprint → original response (status + body) replayed with `Idempotent-Replayed: true`. Same key + different fingerprint → `422 IDEMPOTENCY_KEY_REUSED`. Key still in progress → `409 IDEMPOTENCY_IN_PROGRESS`.
- Correlation: clients may send `X-Correlation-Id`; the API generates one otherwise and returns it on every response and in error bodies.
- Pagination: cursor based — `?limit=50&cursor=<opaque>` → `{ data: [...], nextCursor: string | null }`.
- Concurrency control for master data: `ETag`/`If-Match` (row version) → `412` on conflict.

## Error format

```json
{
  "error": {
    "code": "PRICE_CHANGED",
    "message": "Prices changed since the cart was priced.",
    "details": { "...": "..." },
    "correlationId": "01JA..."
  }
}
```

| HTTP | When |
|---|---|
| 400 `VALIDATION_FAILED` | schema validation (details lists field issues) |
| 401 `UNAUTHENTICATED` | missing/expired token |
| 403 `FORBIDDEN` / `ENTITLEMENT_REQUIRED` | permission or plan missing |
| 404 `NOT_FOUND` | also returned for other tenants' resources (never 403 — no existence oracle) |
| 409 business conflicts | `TOTAL_CHANGED` (details.amountDue), `DUPLICATE_TRANSACTION` (details.saleId, saleNumber — this client transaction was already sold), `SESSION_NOT_OPEN`, `PAYMENTS_OUTSTANDING` (details.payments), `PAYMENT_NOT_SUCCEEDED`, `ALREADY_RETURNED`, … |
| 422 `IDEMPOTENCY_KEY_REUSED` | |
| 429 `RATE_LIMITED` | with `Retry-After` |
| 500 `INTERNAL` | no internals leaked; correlation id included |
| 503 `SERVICE_UNAVAILABLE` | database unreachable / connection lost / statement timeout / serialization failure or deadlock; `Retry-After: 2`. The outcome of a write that was cut off is unknown to the client: **retry with the same Idempotency-Key** (never a new one). |

Clients treat "no response" and any 5xx on a write as *unknown outcome*: keep the Idempotency-Key and retry; for a sale, a later `DUPLICATE_TRANSACTION` points at the recorded sale.

## Webhooks (outbound, Phase 5+)
Signed with HMAC-SHA256 over `timestamp.body`, headers `X-Tilvara-Signature`, `X-Tilvara-Timestamp`, `X-Tilvara-Event-Id`; at-least-once delivery; receivers dedupe on event id.

## Documentation
OpenAPI generated from the Nest controllers + zod contracts (Phase 1), published under `docs/api/openapi.json`.
