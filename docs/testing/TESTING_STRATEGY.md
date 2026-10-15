# 1POS — Testing Strategy

## Layers

| Layer | Tool | Runs against | Command |
|---|---|---|---|
| Unit (pure packages: money, tax, pricing, inventory, accounting) | Vitest | in-memory | `pnpm test` |
| API unit (services with fakes) | Vitest + @nestjs/testing (SWC for decorator metadata) | in-memory | `pnpm test` |
| DB integration (RLS, triggers, constraints, concurrency) | Vitest | real Postgres `onepos_test` (port 55460) as `onepos_app` | `pnpm test:integration` |
| API integration (HTTP → DB) | Vitest + supertest | real Postgres | `pnpm test:integration` |
| E2E UI | Playwright | API + admin-web + pos (browser mode) | Phase 2+ |
| Load | k6 | staging | Phase 6 |

Integration tests auto-migrate `onepos_test` as `onepos_migrator`, then connect as `onepos_app` so RLS is really exercised. Append-only tables cannot be cleaned up, so tests create fresh tenants per test instead of truncating.

## Mandatory suites (release gates)

1. **Cross-tenant adversarial suite** — for every tenant-owned table/endpoint: read, list, update, reference-by-FK, report and export attempts from tenant B on tenant A's data must fail (0 rows / 404). Grows with every new table; a new tenant table without a case in this suite fails review.
2. **Idempotency suite** — duplicate checkout, payment initiation, webhook, refund, sync submissions return the original result; payload mismatch rejected.
3. **Concurrency suite** — last-unit race (N parallel checkouts, policy BLOCK → exactly one succeeds), simultaneous invoice number allocation (no duplicates, no gaps beyond documented cases), concurrent refunds (never exceed refundable), competing stock adjustments.
4. **Ledger integrity** — every journal entry balanced; Σ stock movements = balances; reports reconcile to source rows.
5. **Failure injection** — provider timeout with late success, lost response, duplicate webhooks, worker crash mid-batch (outbox reclaimed), DB connection drop mid-checkout, app restart with local queue (Phase 5), printer failure (sale still committed, reprint available).
6. **E2E scenarios** — retail and restaurant scenarios from spec §15.

## Rules
- A feature is "done" only with its tests passing in CI. Reports state the exact commands run and their results.
- Mocks/dev adapters are named `Dev*`/`Fake*` and never counted as integration coverage of the real provider.
- Money/tax tests use string literals for expected values, never computed floats.
