# Runbook: incident response

For: whoever is on call for Tilvara, and whoever they pull in. It covers how to judge an incident, who does
what, how to keep businesses informed, and how to close it. Security incidents follow this runbook and
[security-incident.md](security-incident.md) together. Personal data involved: the
[breach procedure](../compliance/privacy/breach-procedure.md) starts at the same time, because its
72-hour clock starts when we know.

## 1. Is it an incident?

An incident is anything that stops businesses selling or recording, puts records at risk, or exposes data.
Alerts (see [monitoring.md](monitoring.md)) are the usual start. A business calling support is the other.

Severity decides how fast and how loud:

| Severity | Meaning | Examples | Response |
|---|---|---|---|
| **SEV1** | Selling or recording is down or wrong for several businesses, records are at risk, or data is exposed | API down everywhere; database unreachable; any **release-blocking class** below; a leaked secret; a restore needed | Now, day or night. Incident lead named at once. Businesses told within 30 minutes |
| **SEV2** | One business or one function is badly affected; a workaround exists | One branch cannot sync; card/QR outcomes failing; outbox backlog delaying mail; backups missing | Within the working day, within 2 hours if a business is waiting |
| **SEV3** | Degraded, nothing lost | Slow reports; one till silent; a single `DEAD` outbox event | Next working day; may become a defect instead |

**Release-blocking classes are always SEV1** (THREAT_MODEL): cross-tenant exposure, duplicate charges,
unbalanced journals, untraceable stock movements, secrets in client bundles. So is any sign that records
were changed or deleted outside the append-only path.

Alert severities map simply: a `critical` alert is at least SEV2 and SEV1 when more than one business is
affected; `warning` is SEV2 or SEV3; `info` is not an incident.

When unsure, pick the higher severity. Lowering it later costs nothing.

## 2. Roles

A small team may have one person in all three roles. Name them anyway, in the incident log.

- **Incident lead**: decides. Owns the severity, the plan and the go-ahead for risky steps (a restore, a
  rollback, suspending a business, rotating a secret). Does not do the hands-on fixing on a SEV1 when
  someone else can.
- **Operator**: does the hands-on work and says each step before doing it.
- **Communicator**: keeps businesses and the team informed on a fixed rhythm (section 4).

The DPO joins any incident where personal data may have been seen, changed or lost by someone not
allowed to (breach procedure).

## 3. Steps

1. **Open the incident log** (a ticket or a shared document). Write the UTC time of the first signal, the
   alert or call, and the severity. Every later step gets a line: time, who, what, result.
2. **Stabilise before you diagnose.** The goal is that businesses keep selling and nothing is recorded
   wrong.
   - The desktop tills sell cash offline when the cloud is unreachable and deliver later
     ([offline-terminal-recovery.md](offline-terminal-recovery.md)). Tell browser-mode counters to switch
     to a desktop till or to write receipts by hand.
   - If a release caused it, roll back the code first ([rollback-recovery.md](rollback-recovery.md)).
   - If records are being written wrong, stop the writes: scale the API to zero or block the route at the
     edge. A stopped API is safer than a wrong one, since tills queue offline.
   - Never "fix" by editing tables. Append-only triggers refuse it, and evidence must stay intact.
3. **Find the cause.** Useful places:
   - the alert's section in monitoring.md;
   - API and worker logs (JSON on stdout), filtered by `correlation_id`, `tenant_id` or `user_id`. Every
     API answer carries it as the `X-Correlation-Id` header. The admin and POS do not show it on their
     error screens yet (LEFTOVER), so start from the business, the time and the route;
   - `GET /v1/health/ready` (database, migration head, Redis);
   - the audit log (the business's own in the admin; NULL-tenant rows as `onepos_platform`);
   - the traceability audit over the affected day: `AUDIT_DATABASE_URL=… pnpm --filter @1pos/api exec tsx
     test/dev-audit.ts`.
4. **Fix**, with the incident lead's go-ahead for anything listed under "Incident lead" above.
5. **Verify** with evidence, not impressions:
   - readiness is ok and the alert has cleared;
   - a real checkout works (a test business, or the business on the phone);
   - queued offline sales have arrived (Offline → Tills shows nothing waiting);
   - payments without an outcome are resolved ([payment-reconciliation.md](payment-reconciliation.md));
   - the traceability audit shows no new violations;
   - `dead-letters list` is empty or every row is explained.
6. **Close**: tell businesses it is resolved (section 4), note the end time, and schedule the review.

## 4. Telling businesses

Businesses need to know whether to keep selling, how, and what to check afterwards. They do not need our
internals.

- **First message** (SEV1 within 30 minutes; SEV2 when a business is affected): what is affected, what to
  do now, when the next update comes.
- **Updates**: every 60 minutes on a SEV1, or sooner when something changes. Say "no change" when there
  is none.
- **Resolved**: what happened in one sentence, what they must check or redo, and whether any of their
  records were affected.
- Until the email provider exists (D2), updates go by phone and chat to each affected owner.

Message to adapt (English; the support team gives a Filipino version when the owner prefers it):

> Tilvara is having a problem: [online checkout is not responding]. Desktop tills keep selling cash and will
> send their sales when we are back; card and QR payments are not available until then. Please do not
> ring the same sale twice. Next update by [time]. — Tilvara support

Resolved:

> The problem is fixed as of [time]. Sales rung up on desktop tills during it have been delivered. Please
> check Offline in the back office for any sale waiting for review, and close shifts as usual.
> [Anything they must redo.] We are sorry for the trouble.

Never promise a cause or a figure before it is verified. Never say records were unaffected before the
traceability audit has run.

## 5. After the incident

A short written review within 5 working days for SEV1, 10 for SEV2:

- timeline (from the incident log);
- impact: businesses, branches, duration, sales queued or lost, payments affected, records corrected;
- cause, including why it was not caught earlier (test, alert, review);
- what went well and what slowed us down;
- actions, each with an owner and a date: a test that would have caught it, an alert, a runbook change.

Blameless: the review asks what made the mistake possible, not who made it. Defects found go to
`docs/LEFTOVER.md` or the backlog; runbook fixes are made in the same week.

Keep the evidence (logs, audit exports, the broken database after a restore) until the review closes,
longer if the breach procedure or a business's dispute needs it.
