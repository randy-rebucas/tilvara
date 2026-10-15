# 1POS

Multi-tenant hybrid retail & restaurant POS SaaS (Philippines first). Modular monolith: NestJS API + workers, Next.js admin, React/Tauri POS, PostgreSQL.

- Spec: [docs/SPEC.md](docs/SPEC.md)
- Current status & next task: [docs/STATUS.md](docs/STATUS.md)
- Architecture: [docs/architecture/ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md)
- Backlog: [docs/BACKLOG.md](docs/BACKLOG.md)

## Quick start

```bash
cp .env.example .env
pnpm install
pnpm db:up
pnpm build
pnpm db:migrate
pnpm test && pnpm test:integration
pnpm dev:api   # http://127.0.0.1:4320/v1/health/ready
```

Requires Node ≥ 24, pnpm 10, Docker.
