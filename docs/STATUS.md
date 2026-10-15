# 1POS — Status

_Last updated: 2026-10-15 (session 2)_

## Current phase
**Phase 1 — Platform foundation: DONE** (exit review completed in session 2, commits `5878fc8` + the exit-review UI commit).
Exit criterion — *multiple tenants configure their businesses without unauthorized access* — **met**: schema-wide isolation guard + full cross-tenant API/DB sweep green (see below). Non-blocking Phase 1 gaps are listed under "Carried forward".

**Phase 2 — Retail transaction engine: NOT STARTED.** See "Next task".

Phase 0 done (`159b94e`). Phase 1 slices: 1 identity/onboarding/RBAC · 2 organization · 3 catalog & pricing · 4 team · 5 entitlements, idempotency, outbox + worker · 6 admin web · exit review.

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
**Phase 2 slice 1 — tax foundation.** (1) Read SPEC §Phase 2 + `docs/compliance/PH_COMPLIANCE_ASSUMPTIONS.md`; write ADR for the tax engine. (2) Effective-dated `tax_profiles` per legal entity (VAT/NON_VAT changes versioned; sales snapshot the profile) with RLS + guard/sweep coverage (the isolation suites will force fixture rows for new tables). (3) `@1pos/tax` pure package: VAT-inclusive/exclusive line math, exempt, zero-rated, rounding per entity setting, exhaustive unit tests with worked examples. (4) SC/PWD discount rules implemented behind a feature gate and marked **UNVERIFIED** until a PH tax professional signs off the worked examples (MVP gate #6).
Then: checkout intents + cash tender + idempotent sale persistence, cashier sessions, stock ledger, PayMongo adapter skeleton (Dev adapter first), POS browser app.
