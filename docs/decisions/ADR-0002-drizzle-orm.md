# ADR-0002: Drizzle ORM with SQL-first migrations

- Status: Accepted (2026-10-15)

## Context
We need composite (tenant_id, id) foreign keys, RLS policies, append-only triggers, `SELECT … FOR UPDATE SKIP LOCKED`, and precise control over transactions and session settings. The spec asks for exactly one ORM.

## Options
- **Prisma**: excellent DX; weaker for composite-FK-heavy schemas, RLS needs extensions/raw SQL anyway, transaction-scoped `set_config` via interactive transactions works but the query engine adds a layer.
- **Drizzle**: SQL-shaped TypeScript, generated SQL migrations that are reviewable, raw SQL is first class, works directly on `node-postgres` clients so tenant context and transactions are fully under our control.

## Decision
Drizzle ORM on `pg` (node-postgres). drizzle-kit generates table DDL migrations; RLS policies, triggers, grants and functions go in hand-written custom migrations in the same ordered folder. Migrations run as `onepos_migrator`; the app runs as `onepos_app`.

## Consequences
- Every migration is a reviewed SQL file; forward-only in production, with documented forward-recovery (see `docs/database/DATA_MODEL.md` §Migration strategy).
- No Prisma anywhere in the repo.
