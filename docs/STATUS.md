# 1POS — Status

_Last updated: 2026-10-16 (session 3)_

## Current phase
**Phase 2 — Retail transaction engine: IN PROGRESS.** Slices 1 (tax foundation, `7ee1f3a`), 2 (sales core, `f0fd882`), 3 (payments + receipts, `67486d7`) and 4 (voids/returns) done and verified this session.
Phase 1 done (exit review session 2: `5878fc8`, `980eeda`). Phase 0 done (`159b94e`).

### Phase 2 slice 1 — tax foundation (session 3)
- ADR-0008 (`docs/decisions/ADR-0008-tax-engine.md`): seller = versioned `tax_profiles`, item = `tax_categories.vat_treatment`, buyer entitlement = platform `discount_schemes`; pure engine; per-line centavo rounding; snapshots; review gate.
- DB: migrations 0014 (tables + backfill: every existing legal entity got its current VAT status/rounding as an initial profile — dev DB: 10 VAT, 2 non-VAT — then `legal_entities.vat_status/rounding_mode` dropped) and 0015 (forced RLS, append-only + no-backdating triggers, grants, SC/PWD seed).
- `@1pos/tax`: golden vectors ₱1,120 → ₱800 (VAT seller, SC) and ₱1,120 → ₱896 (non-VAT, PWD), mixed carts, exclusive prices, partial beneficiary share, refusals (stacking, unsupported VAT-keeping schemes, bad profiles), 2,000 random carts checking every peso is accounted for once.
- API: `GET/POST /v1/legal-entities/:id/tax-profiles` (create needs `tax.manage`; VAT status no longer editable via PATCH — 400), `GET /v1/discount-schemes`, `POST /v1/tax/quote` (server-authoritative price + tax for a cart at a branch; cashier allowed incl. SC/PWD; ordinary discounts need `sales.discount`; branch scope enforced; `requiresProfessionalReview` flag).
- Defect found & fixed: price and profile effective dates mixed the API host clock with the DB clock (Docker drift ≈0.2 s) → a just-set price/profile could read as "not yet effective". The DB clock is now the single clock for effective dating (`apps/api/src/common/clock.ts`).
- Guards worked as intended: the schema guard flagged the new global table (allow-listed with reason) and the router guard flagged the 2 new `:id` routes (added to the attack matrix + 2 quote smuggling cases).

### Phase 2 slice 2 — sales core (session 3)
- ADR-0009. Migrations 0016/0017: `cashier_sessions`, `cash_movements`, `cash_reconciliations`, `sequence_counters`, `sales`, `sale_beneficiaries`, `sale_lines`, `sale_tenders`, `stock_movements`, `stock_balances` — forced RLS, append-only evidence tables, session state-machine + open-session triggers, approve-once trigger, SECURITY DEFINER balance trigger (app can read, never write balances).
- API: `POST/GET /v1/cashier-sessions`, `GET /v1/cashier-sessions/:id`, `POST …/:id/movements|close|approve-variance`, `POST /v1/sales` (Idempotency-Key **required**), `GET /v1/sales`, `GET /v1/sales/:id`, `POST /v1/stock/adjustments`, `GET /v1/stock/balances|movements`.
- Tests (`sales.test.ts`, 19): full shift reconciles (lines→totals, tenders→due+change, drawer→due, stock→−qty, expected cash, zero-variance close); retry replays; 5 concurrent same-key → 1 sale; same clientTransactionId under new key → DUPLICATE_TRANSACTION; key required; 10 concurrent sales → numbers 1..10 and a failed sale consumes none; 5 failure modes leave no rows; stale total reports the new amount; beneficiary validation; one open session per register; not-owner/closed-session refusals; variance approval by another user, self-approval refused, approve once; branch scope; stock permissions, negative stock visible; append-only evidence and read-only balances.
- **Defect found & fixed:** intermittent "TAX_PROFILE_MISSING"/not-yet-priced right after setup. Root cause measured, not guessed: the Docker DB clock stepped back ≈0.9 s between transactions (later session `opened_at` < earlier profile `effective_from`). Fix: effective-date resolution allows 5 s skew (ADR-0009 §8), regression test added; 10/10 stress runs green (was ~1 in 3–8 failing).

### Phase 2 slice 3 — payments and receipts (session 3)
- ADR-0010. Migrations 0018/0019: `payment_intents` (trigger: PROCESSING → SUCCEEDED|FAILED|UNKNOWN; UNKNOWN → SUCCEEDED|FAILED; SUCCEEDED → CANCELED if unconsumed; consumed once; identity immutable), append-only `payment_events`; `sale_tenders` gains CARD/QR/EWALLET with `payment_intent_id` (unique, no change on electronic tenders).
- API: `POST /v1/payment-intents` (Idempotency-Key required, stored on the intent), `GET /v1/payment-intents?cashierSessionId=`, `GET /v1/payment-intents/:id` (with events), `POST …/:id/reconcile`, `POST …/:id/cancel`; `POST /v1/sales` accepts `{ method: 'INTENT', paymentIntentId }` tenders; `GET /v1/sales/:id/receipt`.
- `PAYMENT_PROVIDER=dev` only (production boot refuses it); `PAYMENT_TIMEOUT_MS` (default 15 s).
- Tests: 9 payment cases (split tender reconciles, card-only moves no cash, retry → same intent and 1 charge, decline, lost response → UNKNOWN → reconcile SUCCEEDED with 1 charge, never-received → FAILED, cancel, mismatch/overpayment/double tender leave no sale, owner-only + key required); receipt unit tests (never "official receipt", TIN with branch code, local time, VAT/non-VAT breakdowns, SC block) + API check; isolation +4 id routes, +3 smuggling cases, intents/events in the DB sweep.

### Phase 2 slice 4 — voids and returns (session 3)
- ADR-0011. Migrations 0020/0021: `sale_returns`, `sale_return_lines` (forced RLS, append-only, open-session trigger, within-sold trigger); `cash_movements` gains REFUND (negative, linked to the return); `stock_movements` gains RETURN (positive, linked to the return line) with direction checks.
- API: `POST /v1/sales/:id/returns` (Idempotency-Key required; VOID or RETURN), `GET /v1/sales/:id/returns`; sale view shows `returnedQuantity` per line.
- Tests (7): exact three-way proration + restock + drawer back to float; DAMAGED not restocked; SC return refunds what was paid; void once, only in its session; cashier forbidden, stale refund, insufficient drawer cash (nothing written); 4 concurrent returns of the last unit → exactly one; replayed void; append-only. Isolation: +2 id routes, +1 smuggling case, return tables in the DB sweep.

## Verified in session 3 (commands actually run, all green)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` · `pnpm exec oxlint apps packages` · `pnpm --filter @1pos/api openapi` | ok |
| `pnpm test` | **87 passed** (tax 27, api 22, money 15, config 6, validation 5, observability 5, workers 2) |
| `pnpm test:integration` | **172 passed** — database 21, api **143** (sales+payments+returns 35, tax 18, isolation 9, …), workers 8 |
| `pnpm test:e2e:web` | **19/19** against live API + `next start` |
| dev DB | migrated 0014/0015; backfill verified |

## User decisions (2026-10-15)
- **No GitHub remote yet** — keep the repo local; CI deferred. Don't create one until asked.
- **Payment provider: PayMongo** (Phase 2 payment adapter targets PayMongo; dev adapter until keys are provided).
- **Hosting: cloud** (specific provider/region still open — keep Docker images provider-neutral; OTel exporter choice waits on this).

## Verified in session 2 (commands actually run, all green)
| Command | Result |
|---|---|
| `pnpm build` · `pnpm typecheck` · `pnpm exec oxlint apps packages` | ok, lint exit 0 |
| `pnpm test` | **55 passed** (money 15, config 6, validation 5, observability 5, workers 2, api 17 incl. OpenAPI drift check) |
| `pnpm test:integration` | **119 passed** — database **21** (14 + 7 schema guard), api **90** (77 + isolation 9 + logging 4), workers **8** |
| `pnpm test:e2e:web` | **19/19** against live API + `next start` |
| `node apps/admin-web/e2e/review.mjs` | **18/18** — 15 states × 1440/390 captured to `.impeccable/review/screens/`, no horizontal scroll at 390 anywhere |
| live boot | built API logs JSON access lines with correlation id; built worker delivered 31 queued events, each logged with origin `correlation_id` + `tenant_id` |

## Phase 1 exit review — what was checked and found
1. **Cross-tenant isolation**
   - `packages/database/test/integration/rls-catalog.test.ts` reads the system catalog: every table is tenant-keyed or allow-listed with a reason; ENABLE+FORCE RLS with only the canonical `tenant_id = app_current_tenant_id()` policy; `UNIQUE(tenant_id,id)` (reviewed leaf exceptions: audit_logs, idempotency_records, outbox_events, subscriptions — and a check that nothing references them); tenant→tenant FKs include `tenant_id`; runtime role owns nothing and has no TRUNCATE/TRIGGER/REFERENCES; SECURITY DEFINER functions owned by `onepos_platform`, pinned `search_path`, not PUBLIC-executable; `platform_set_subscription` not granted to the app. Mutation-tested with a deliberately unprotected table (3 tests fail as intended).
   - `apps/api/test/integration/isolation.test.ts`: two fully configured tenants; the attack matrix is asserted **equal to the live router's `:id` routes** (29 — a new id route without a case fails the suite) → all 404 NOT_FOUND; 16 body/query id-smuggling cases → 403/404; list/read endpoints deep-scanned for foreign ids; DB sweep driven by the catalog (fixture puts rows in every tenant table; runtime role in B's context sees/updates none of A's rows; WITH CHECK blocks foreign inserts; no context → no rows).
   - **Defect found & fixed:** `GET /v1/variants/:id/price-history` returned `200 []` for foreign/unknown variants (no data leak, but an inconsistent existence signal) → now 404.
   - Accepted by design: `audit_logs.tenant_id` NULL = platform-level event, visible to no tenant.
2. **OpenAPI**: `docs/api/openapi.json` (OpenAPI 3.1, 64 operations) generated from Nest route metadata + the same zod schemas the pipes use (`pnpm --filter @1pos/api openapi` after `pnpm build`). Documents bodies, queries, path ids, Idempotency-Key, rate limits, declared permissions and the error envelope. **Response bodies are not schema-typed yet.** Unit test fails on drift.
3. **Logging / OTel**: new `@1pos/observability` (pino JSON, redaction of credentials/tokens/cookies, AsyncLocalStorage context, `trace_id`/`span_id` mixed in when an OTel SDK is active). API: access log per request (route pattern, status, duration — never query/body/headers); tenant id added only after membership re-check. Worker: per-event scope with origin correlation + tenant id. `LOG_LEVEL` env. **No OTel SDK/exporter installed yet** (waits on hosting choice).
4. **Admin screens**: new `e2e/review.mjs` (shared CDP harness `e2e/cdp.mjs`). Findings fixed: raw zod messages ("Too small: expected string…") shown to users → API now sends issue `code`+bounds and the web translates (EN/FIL); single-choice selects labelled in plural; **₱ rendered as "P" at 13–15px** (Archivo's hairline bars) → U+20B1 now drawn from a system face via `unicode-range`. Also fixed a race in `smoke.mjs` (TIN hint text satisfied the wait before the POST). Not fixed (logged in BACKLOG): tables at 390px scroll inside their container so trailing columns/actions start off-screen; some FIL strings still English (enum labels like "VAT-registered").

## Carried forward from Phase 1 (non-blocking for Phase 2)
MFA (TOTP) for privileged roles · password reset (needs real email adapter) · Redis rate limiter (in-memory now; single instance only) · real email provider · OTel SDK + exporter · typed response schemas in OpenAPI · `onepos_worker` DB role · admin UI: product edit/variants, custom-role editor, member role editing, price-list create · Filipino copy native review · CI (needs remote). Lockout reveals account existence via 429 (accepted). Node `crypto.argon2` still experimental in Node.

## Next task (start here)
**Phase 2 slice 5 — basic reports** (each must reconcile to source rows, tested): sales summary per branch/day (gross, discounts, statutory, VAT buckets, net of returns), by product, by cashier, by tender method, returns/voids, tax summary (VATable / VAT / exempt / zero-rated / percentage-tax sales), SC/PWD sales book (name, ID, gross, discount, sale/return numbers — RR 5-2017 §5.9), cashier-session (X-reading-like) report. Read-only, `reports.read` with branch scope; date ranges in the branch timezone. Then slice 6: POS browser checkout UI (`apps/pos-desktop` browser mode) and the Phase 2 exit review ("complete retail transactions reconcile under normal, retry, and failure conditions").
Carried: admin UI for tax profiles; SC/PWD professional sign-off (gate #6); PayMongo adapter + card/QR refunds (needs sandbox keys).
