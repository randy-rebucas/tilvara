# Tilvara — Prioritized Backlog (open items only)

Legend: 🟡 partial · ⬜ not started · ⏳ waiting on a decision or someone else. Update this file at the end of every session.
Only work that is not done lives here. Finished phases and slices are recorded in [STATUS.md](STATUS.md) and the git history (the full backlog up to 2026-10-27 is in commit `5e826bc`). Detail on each open item is in [LEFTOVER.md](LEFTOVER.md); the second full audit's open items are in [OPEN-ITEMS-2026-10-27.md](OPEN-ITEMS-2026-10-27.md).

## Decisions waiting on the user
- ⏳ D1 hosting provider/region · D2 email provider · D4 pilot businesses · D5 invoicing during the pilot (tax adviser) · D6 PayMongo keys.
- ⏳ Mobile app (SPEC §5.3): no app and no plan; scope and timing are the user's call.

## Gates waiting on professionals
- ⏳ SC/PWD rules: worked examples signed off by a PH tax professional (MVP criterion 6; `discount_schemes` stay PENDING_PROFESSIONAL_REVIEW, refused in production).
- ⏳ Accountant's answers (`docs/accounting/ACCOUNTANT_REVIEW_REQUEST.md`) before customers rely on the books, incl. store credit on `CUSTOMER_STORE_CREDIT` (question 11) and EWT / BIR 2307.
- ⏳ Tax adviser: customer VAT treatment.
- ⏳ DPO review of the privacy pack (G6) and the purge/retention periods, which unblock:
  - ⬜ anonymisation job for offboarded businesses past retention;
  - ⬜ anonymisation job for closed accounts (`users.closed_at`);
  - ⬜ automatic customer anonymisation (proposed 2 years after the last purchase);
  - ⬜ automatic discard of held carts (proposed 7 days);
  - ⬜ webhook delivery purge;
  - ⬜ purge jobs for `user_sessions`, `password_reset_tokens`, `email_change_tokens`, `member_invitations` and delivered `outbox_events`.

## Phase 5 — Offline & integrations
- ⬜ Slice 6 — PayMongo adapter + webhooks for sale payments; invoice transmission (deferred by the user; needs D5, D6).
- ⏳ Subscription billing: PayMongo sandbox run (D6).

## Phase 6 — Pilot readiness
- ⬜ Slice 7 — deployment (needs D1, D3): Dockerfiles, container scan, CI, staging, secrets manager, migration procedure.
  - ⏳ Backups: point-in-time recovery (WAL), off-site copy with a retention lock, scheduling on a host, drill against managed Postgres (D1).
  - ⏳ Performance: re-measure on D1 staging (checkout p99 1.6 s vs 1 s target; sync-50 worst 5.9 s miss the targets on this laptop).
  - ⏳ Shop addresses: wildcard DNS `*.<domain>` + wildcard certificate, Host header passed through, `BFF_SHARED_SECRET` and proxy hops set in hosting (D1).
- ⬜ Slice 9 — UAT scripts, compliance release review, pilot runbook + daily reconciliation report (needs D4–D6).
- ⬜ Customer accounts receivable (sales on account, statements, customer payments).

## Hardware and real-device checks
- ⬜ Printed logo on thermal receipts (`@1pos/escpos` needs a raster image command, 1-bit dither at 384/576 dots).
- ⬜ Real printer and cash drawer check on the desktop till (drawer kick after cash sale/refund/pay in-out).
- ⏳ Re-pairing rule: the till hands waiting sales to any new terminal of the register, the server only to one replacing a REVOKED terminal (else quarantined `UNKNOWN_SNAPSHOT`). Your call which way (LEFTOVER "Second tenant audit").
- ⏳ Hardware adapters beyond ESC/POS.

## Extensions (ADR-0026)
- ⬜ Pharmacy as the first extension (its own slice, checklist `docs/architecture/extensions.md`).

## Phase 7 — Differentiation (validated demand only)
- ⬜ Ecommerce, loyalty, forecasting, replenishment, loss-prevention analytics, multi-branch intelligence.
