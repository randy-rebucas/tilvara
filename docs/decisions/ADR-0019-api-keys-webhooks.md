# ADR-0019: API keys and outbound webhooks

- Status: Accepted (2026-10-20, session 20). Audit gap "no outbound webhooks or API keys" (`docs/AUDIT-2026-10-19.md`).
- SPEC §6.11 (integrations), §12 (security). Builds on ADR-0010 (outbox), ADR-0016 (account security, worker role, rate limits), ADR-0005 (entitlements).

## Decision
1. **An API key is read-only and belongs to a business.** `Authorization: ApiKey tlv_<prefix>_<secret>`: a 10-character prefix that is shown in lists, and a 256-bit secret. The key is shown once, at creation. Only its SHA-256 hash is stored: `api_keys.key_hash` has no SELECT grant for `onepos_app`, `onepos_readonly` or `onepos_worker`, and is an export secret column. A request is resolved by the SECURITY DEFINER `auth_api_key(prefix, hash)` (app role only). It returns the tenant and the scopes only while the key is neither revoked nor expired, and it updates `last_used_at` at most once a minute. The trigger `api_keys_guard` allows a key to be revoked once and nothing else to change; keys are never deleted.
2. **Scopes are tenant-wide read grants.** `org.read`, `catalog.read`, `sales.read`, `inventory.read`, `reports.read` and `customers.read` map onto the existing permission codes. `AuthGuard` builds a session for the key with exactly those grants at tenant scope and no user or membership, so every route's own checks apply unchanged. Any method other than GET is refused with 403 `API_KEY_READ_ONLY` before a handler runs. A key never reaches members, roles, credentials, billing, integrations or support access, because no scope grants those codes.
3. **Plans with API access only.** Making a key or a webhook, and using a key, need the plan feature `api_access` (Enterprise in the seed). A downgrade stops keys at once (403 `ENTITLEMENT_REQUIRED`) without revoking them; upgrading again restores them. Managing integrations needs `integrations.manage` (owner and admin templates).
4. **Webhooks carry ids, never records.** Topics: `sale.completed`, `sale.returned`, `sale.voided`, `stock.low`, `stock.below_zero`, plus `webhook.ping` for a test. The body is `{id, type, createdAt, data}`, where `data` is the outbox payload: ids, numbers and codes, with no names, contact details or amounts tendered. A receiver that needs more reads it with an API key. This keeps personal data out of third-party logs.
5. **Fan-out happens in the outbox handler's transaction.** For every webhook topic the worker wraps the handler (`withWebhooks`), and `webhook_enqueue(event_id)` inserts one `webhook_deliveries` row per enabled endpoint that listens to the topic. The rows commit with the event's completion, so an event is fanned out exactly once.
6. **Delivery is a separate worker loop.** `webhook_claim`/`webhook_settle` are SECURITY DEFINER functions, worker only: the worker has no table writes.
   - A delivery is a POST with `Tilvara-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">`. The endpoint's secret is `HMAC(WEBHOOK_SIGNING_KEY, endpointId:salt)`, so only a salt is stored and rotating the secret replaces the salt (the old secret stops at once).
   - Any 2xx counts as delivered. Anything else, a timeout (`WEBHOOK_TIMEOUT_MS`) or a refused address is a failed try: retried with exponential backoff from 30 s (±20 %), up to 8 tries (about an hour), then `DEAD`. A test ping gets one try.
   - A `DEAD` delivery can be sent again from the admin (audited); the alert `OneposWebhookDeliveriesDead` fires on new DEAD rows.
7. **No request forgery into the hosting network.** An endpoint must be `https` on a host that is not loopback, private, link-local, CGNAT, multicast or unspecified (checked when it is saved). The worker resolves the host again before each try and refuses it if any address is not public, and it never follows a redirect. `WEBHOOK_ALLOW_INSECURE=true` allows http and private hosts for development; production config refuses it.
8. **Admin.** Subscription → Integrations lists the keys (prefix, scopes, last used, revoke) and the webhooks (topics, on/off, waiting and gave-up counts, test, new secret). It also has a page of the last 100 deliveries per endpoint, with the answer each one got and "Send again". Every change is audited (`api_key.*`, `webhook.*`), naming a key by its prefix only.

## Consequences
- Another system can read a business's sales and stock without a person's account or password, and a key can be cut off without touching anyone's sign-in.
- Receivers verify every message and must accept the same delivery twice (at-least-once delivery: a worker can stop after the POST and before settling). The `id` in the body is stable across retries.
- `webhook_deliveries` grows with every event. It is excluded from the data export (operational, ids only) and is not purged yet (LEFTOVER).

## Not covered
- Write access through API keys, OAuth apps, or keys scoped to one branch.
- Per-key rate limits beyond the existing per-IP limits.
- Pinning the resolved address for the connection itself. Between the worker's DNS check and `fetch`'s own lookup, a DNS answer can change (rebinding, a time-of-check/time-of-use gap). This is recorded in LEFTOVER, to be closed with a custom lookup/agent before production.
- Webhooks for other topics (purchasing, books, restaurant checks).
