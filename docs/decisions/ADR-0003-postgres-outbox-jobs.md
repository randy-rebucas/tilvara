# ADR-0003: Postgres transactional outbox as the durable job system

- Status: Accepted (2026-10-15)

## Context
Side effects (receipt printing jobs, e-invoice transmission, webhooks, notifications, reconciliation) must happen **iff** the business transaction committed, and must survive worker crashes. A Redis queue (BullMQ) cannot be enqueued atomically with a Postgres commit.

## Decision
- Domain transactions insert rows into `outbox_events` in the same DB transaction.
- `apps/workers` claims rows with `SELECT … FOR UPDATE SKIP LOCKED LIMIT n`, processes them with idempotent handlers, records attempts, backs off exponentially, and moves exhausted rows to `DEAD` for operator review.
- Scheduled jobs (reconciliation, reports) are rows in a `scheduled_jobs` table claimed the same way.
- Each job row carries `tenant_id`; the worker sets tenant context from the row, never from the payload.
- Redis is used only for rate limiting, caching and short-lived coordination.

## Consequences
- One fewer durable system to operate and back up.
- Throughput ceiling is far above pilot needs; revisit (e.g. pg-boss or a broker) if outbox lag metrics demand it.
