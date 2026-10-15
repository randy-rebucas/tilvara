# 1POS — Threat Model (STRIDE, initial)

Scope: cloud API + workers + Postgres, admin web, POS terminal (browser mode now, Tauri/SQLite later), payment/EIS integrations, support staff.

## Assets
Sales & invoices (legal records), payment references, cash records, inventory/cost data, customer PII, user credentials & sessions, terminal credentials, tenant configuration (prices, tax), backups/exports, audit logs.

## Trust boundaries
1. Internet ↔ API (all clients untrusted, including registered terminals).
2. API ↔ Postgres (runtime role `onepos_app`, RLS forced).
3. Workers ↔ external providers (payment, EIS, notifications).
4. Terminal local storage (SQLite) — **attacker-modifiable** by anyone with device access.
5. Platform staff ↔ tenant data.

## Threats and controls

| # | Threat (STRIDE) | Example | Controls | Test |
|---|---|---|---|---|
| T1 | Tenant ID manipulation (E/I) | Send `tenantId` of another tenant in body/header | Tenant derived from session membership only; RLS forced; composite FKs | Cross-tenant adversarial integration suite |
| T2 | Pool context leak (I) | Request B inherits A's `app.tenant_id` | `set_config(..., true)` transaction-local only; no session-level SET | Test: after tx end, setting is empty on same connection |
| T3 | Price/discount tampering (T) | Client sends total ₱1 | Server recomputes from versioned config; client total only compared | Checkout test with forged totals |
| T4 | Duplicate charge/sale (T) | Retry after timeout | Idempotency key + `(terminal, terminal_txn_id)` unique; payment intent reuse | Concurrency + retry tests |
| T5 | Refund/void abuse (E) | Cashier refunds to own e-wallet | Permission + manager approval thresholds; refund ≤ refundable; anomaly reports | Refund-limit tests |
| T6 | Forged webhook (S) | Fake "payment succeeded" | HMAC/signature verification, timestamp window, event-id dedupe, confirm via provider API | Webhook signature tests |
| T7 | Unauthorized invoice issuance (E) | Issue numbers outside workflow | Numbers allocated only server-side in sale commit; sequence row lock; gap audit | Concurrent issuance test |
| T8 | Unauthorized stock adjustment (E/R) | Hide theft via adjustment | Permission + reason code + audit + variance report | Permission tests |
| T9 | Revoked terminal replay (S) | Stolen terminal keeps syncing | Terminal credential revocation checked every sync; device sequence monotonic | Revoked-terminal sync test |
| T10 | Local SQLite tampering (T) | Edit offline sale amounts | Server re-validates every synced sale against price versions; mismatches flagged, not trusted | Sync validation tests |
| T11 | Secret leakage in client bundle (I) | API keys in Next.js `NEXT_PUBLIC_*` | Only public config in client env; CI grep for secrets; gitleaks | CI check |
| T12 | Credential stuffing (S) | Password spraying | argon2id, rate limits per IP+account, MFA for privileged roles, lockout with backoff | Rate-limit tests |
| T13 | Session theft (S) | Stolen refresh token | Rotation + reuse detection revokes family; short access TTL | Token reuse test |
| T14 | Support over-access (I/E) | Staff browse tenant sales | Time-boxed, tenant-approved grants; audit every access | Support-grant tests |
| T15 | Export/backup exposure (I) | Public bucket | Private bucket, signed short-lived URLs scoped to tenant, encrypted backups | Export access tests |
| T16 | Audit tampering (R) | Delete audit rows | Append-only trigger; app role has no UPDATE/DELETE grant | Trigger test |
| T17 | PII in logs (I) | Customer phone in logs | Structured logger redaction list; no request body logging by default | Log redaction test |
| T18 | DoS on checkout (D) | Flood API | Rate limiting per terminal/tenant; graceful degradation to offline cash at terminal | Load test (Phase 6) |
| T19 | Dependency compromise | Malicious package | Lockfile, `pnpm audit`, Renovate review, minimal deps | CI |
| T20 | Payment data handling (I) | Storing PAN/CVV | Never accept card data; provider-hosted fields/terminals only; store provider tokens/refs only | Code review gate |

## Release-blocking classes
Cross-tenant exposure, duplicate charges, unbalanced journals, untraceable stock movements, secrets in client bundles.
