# ADR-0001: Modular monolith in a pnpm + Turborepo monorepo

- Status: Accepted (2026-10-15)

## Context
The product spans ~15 business domains but has no production load, a single team, and strong cross-domain transactional requirements (sale + stock + journal + invoice in one commit).

## Decision
One NestJS API and one worker binary built from shared domain modules, one PostgreSQL database. pnpm workspaces + Turborepo for task orchestration and caching. Pure business calculations live in framework-free packages so they can be reused by the offline POS and unit-tested without a database.

## Consequences
- Checkout can commit sale, inventory, accounting and outbox atomically — impossible across microservices without sagas.
- Module boundaries must be policed (review + later a lint rule); otherwise the monolith degrades.
- Extraction path: a module whose tables are only touched through its service and whose events go through the outbox can later become a service.
