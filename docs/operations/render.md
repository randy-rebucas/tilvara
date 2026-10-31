# Runbook: Tilvara on Render

For: ops setting up and releasing Tilvara on [Render](https://render.com). It applies
[deployment.md](deployment.md) to Render; read that first. The Blueprint is `render.yaml` at the
repository root.

## 1. What this gives, and what it does not

**A staging environment**, not production. `render.yaml` runs with `NODE_ENV=development`, because
production refuses to boot until the mailer (D2), file storage (D1) and card/QR payments (D6) have real
adapters (deployment.md). In this environment:

- money is never real: the card/QR and billing simulators run, and only PayMongo **test** keys may be set
  (the config refuses live keys outside production);
- no email is sent: the dev mailer logs a template name and a masked address. Invitations and password
  resets cannot be completed by mail; sign-up and signing in work;
- **data exports fail**: the dev file storage is a folder on one machine, and the API and the worker are
  separate Render services with separate disks. The worker writes the file where the API cannot serve it.
  This lasts until the object-storage adapter exists;
- invoices stay disabled, as everywhere (docs/compliance).

Load staging only with made-up businesses (`pnpm seed:sample --api https://<api host>`), never a real
shop's records.

What Render provides:

| Blueprint name | Render type | Tilvara piece |
|---|---|---|
| `tilvara-db` | Render Postgres 18 | the database (`onepos`) |
| `tilvara-redis` | Key Value | rate-limit counters |
| `tilvara-api` | web service | API (`/v1/health/ready` as health check) |
| `tilvara-worker` | background worker | outbox worker |
| `tilvara-admin` | web service | admin web |
| `tilvara-till` | static site | browser till |

Everything is in the `singapore` region, the one nearest the Philippines. All of it must be in one
region so the services reach the database and Key Value over Render's private network.

## 2. Check the database privileges first

Tilvara needs two roles with `BYPASSRLS`: `onepos_platform` (owner of the audited cross-tenant
functions) and `onepos_backup`. PostgreSQL lets only a superuser, or a role that itself has `BYPASSRLS`,
create them. Render does not document what its database user may do, so check before anything else.

1. Create **only** the database first: in the Render dashboard, New → Postgres, name `tilvara-db`,
   database `onepos`, user `onepos_owner`, region Singapore, version 18. Add your own address to its
   access control for now.
2. Connect with its external URL and run:
   ```sql
   SELECT rolsuper, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user;
   ```
3. Read the answer:
   - `rolsuper` or `rolbypassrls` true, and `rolcreaterole` true: Render Postgres works. Continue with
     section 3. (Then delete this database again and let the Blueprint create it, or keep it and remove
     `databases:` from `render.yaml` before applying the Blueprint.)
   - Otherwise: Render Postgres cannot hold Tilvara as designed. Do not weaken the roles to make it fit
     (no RLS bypass means the platform functions fail; a superuser app login means no isolation). Use
     section 8 instead.

## 3. Create the roles (once)

Connected as `onepos_owner` with the external URL, run the role part of
`infra/docker/postgres/init/01-roles.sql` with **new passwords** (a password manager's 32+ random
characters each, kept in the ops vault), not the `_dev` ones. Then the database lines:

```sql
-- the CREATE ROLE / GRANT lines of 01-roles.sql, passwords replaced
ALTER DATABASE onepos OWNER TO onepos_migrator;
-- connected to onepos:
ALTER SCHEMA public OWNER TO onepos_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO onepos_app, onepos_worker, onepos_readonly;
```

Skip `CREATE DATABASE onepos_test`: tests never run against Render.

If `ALTER DATABASE … OWNER` or `GRANT pg_read_all_data` is refused, stop: the user lacks the rights
section 2 checked for. Go to section 8.

Connection strings, from the database's **internal** URL with the user and password replaced:

| For | Login | Where it goes |
|---|---|---|
| API | `onepos_app` | `tilvara-api` → `DATABASE_URL` |
| Worker | `onepos_worker` | `tilvara-worker` → `DATABASE_URL` **and** `WORKER_DATABASE_URL` |
| Migrations, support CLI | `onepos_migrator` | ops vault only, with the **external** URL |
| Backups | `onepos_backup` | ops vault only, with the **external** URL |

Internal URLs: leave out `sslmode`. Render's internal TLS uses self-signed certificates, and the `pg`
driver Tilvara uses treats `sslmode=require` as full verification, which those fail. Traffic stays on
Render's private network. External URLs are always TLS; if the Node tools refuse the certificate, add
`&uselibpqcompat=true` so `require` means what it means in `psql`.

Never put the migrator or backup login in a Render service's environment (production-access.md).

## 4. First deploy

1. **Migrate** from the ops machine, with your address allowed on `tilvara-db`:
   ```
   pnpm install --frozen-lockfile
   pnpm build
   $env:DATABASE_MIGRATOR_URL = "<external migrator URL>"
   pnpm --filter @1pos/database exec node dist/migrate.js
   ```
   (`pnpm db:migrate` reads `.env`; setting the variable in the shell, and running `dist/migrate.js`
   directly, keeps the Render credential out of your dev `.env`.) It prints `Migrations applied`.
   Check `SELECT * FROM platform_migration_head();` as the migrator.
2. **Apply the Blueprint**: Render dashboard → New → Blueprint → this repository, branch `main`. Render
   reads `render.yaml` and asks for each `sync: false` value:
   - `tilvara-api` `DATABASE_URL`: the `onepos_app` internal URL.
   - `tilvara-api` `CORS_ORIGINS`: `https://<admin host>,http://tauri.localhost`.
   - `tilvara-api` `APP_PUBLIC_URL`: `https://<admin host>`; `API_PUBLIC_URL`: `https://<api host>`.
   - `tilvara-worker` `DATABASE_URL` and `WORKER_DATABASE_URL`: the `onepos_worker` internal URL.
   - `tilvara-admin` `ONEPOS_API_URL`: `http://<tilvara-api internal host>:10000/v1` (the internal host is
     on the API's Connect panel). The `/v1` is required.
   - `tilvara-admin` `ONEPOS_POS_URL`: `https://<till host>`.

   The hosts are `<name>.onrender.com` unless Render adds a suffix to a taken name, or the custom
   domains of section 5. If you do not know them yet, enter a placeholder and correct it in the dashboard
   after the first deploy.
3. **Deploy** the services, API first. The API is live when `https://<api host>/v1/health/ready` answers
   `{"status":"ok", … "migrations":"up" …}`. The worker logs `worker started`. The admin answers its
   sign-in page.
4. **Smoke test**: sign up a business on the admin, add an item, open the till, ring a cash sale, close
   the shift, then check Reports and the journal. Or run `pnpm seed:sample --api https://<api host>/v1`
   (from the ops machine) and look around.
5. Remove your address from `tilvara-db`'s access control.

Secrets with `generateValue: true` (JWT, MFA key, BFF secret, webhook key, metrics token) are made by
Render on the first apply and shared between services through `fromService`. Render never changes them
on later syncs.

## 5. Domains and the till

- Custom domains: in each web service's Settings → Custom Domains, e.g. `api.staging.<domain>`,
  `app.staging.<domain>`, `till.staging.<domain>`. Then update `CORS_ORIGINS`, `APP_PUBLIC_URL`,
  `API_PUBLIC_URL`, `ONEPOS_POS_URL` and the till's `/v1/*` rewrite in `render.yaml`.
- The till's rewrite (`routes:` in `render.yaml`) must name the API's public address: it is a Blueprint
  value, not an environment variable, so edit `render.yaml` and sync.
  - Check after the first deploy that a sign-in on the browser till works through the rewrite. If it does
    not, use desktop tills only; they talk to the API directly.
- Desktop tills: build the installer with `VITE_API_URL=https://<api host>` (deployment.md section 7) and
  enter that address at set-up.
- Shop addresses (`<slug>.<domain>`): need a wildcard custom domain `*.<shop domain>` on `tilvara-admin`
  plus `ONEPOS_ADMIN_URL`, `ONEPOS_SHOP_DOMAIN` (admin) and `SHOP_DOMAIN` (API). Off until set.
- Proxy hops: `TRUST_PROXY_HOPS=1` and `ONEPOS_TRUST_PROXY_HOPS=1` count Render's load balancer. Putting
  Cloudflare or another proxy in front adds one.

## 6. Releasing

Same order as deployment.md section 6, with Render's buttons:

1. Gate the commit on your machine (deployment.md 6.1).
2. Back up (section 7).
3. Migrate as in section 4 step 1 (allow your address, migrate, remove it).
4. Dashboard → `tilvara-api` → Manual Deploy → the commit. Render starts the new instance and switches
   traffic only once `/v1/health/ready` answers 200, so a build whose migrations are missing never
   takes traffic; the deploy fails and the old one keeps serving.
5. Then `tilvara-worker`, `tilvara-admin`, `tilvara-till`.

Auto-deploy is off in the Blueprint for that reason: a push must not deploy ahead of its migrations.
Changing `render.yaml` itself takes effect when the Blueprint syncs.

**Rolling back**: Dashboard → service → Events → the previous deploy → Rollback. Rules of
rollback-recovery.md section 2 apply: the schema is never rolled back; the previous build runs on the newer
schema because releases ship expand migrations only.

**Never** regenerate `MFA_ENCRYPTION_KEY` (every authenticator enrolment becomes unreadable; rotate with
`mfa-rekey`, security-incident.md 2.5.1) or `WEBHOOK_SIGNING_KEY` (every webhook endpoint's secret
changes). Changing `JWT_ACCESS_SECRET` signs everyone's access tokens out within 15 minutes; refresh
sessions survive.

## 7. Backups

Two layers:

- **Render's own**: paid Render Postgres plans have point-in-time recovery and logical exports
  (dashboard → database → Recovery). This is the first resort for losing the database. Render keeps no
  backups of a **deleted** database: protect `tilvara-db` from deletion and never delete the Blueprint
  with it.
- **Tilvara's encrypted backups** (backup-restore.md): from the ops machine with `BACKUP_DATABASE_URL` =
  the backup login's external URL, `pnpm backup run`, daily and before every migration. A Render cron job
  cannot do this: its native runtime has no `pg_dump` 18, and its disk does not outlive the run. The
  monthly restore drill runs on the ops machine against the newest dump.

## 8. When Render Postgres cannot create the roles

If section 2 or 3 failed, run Postgres yourself on Render, or keep Render for the apps and put the database
elsewhere (in the same region, with a private connection). The self-run option:

- A **private service** from the image `postgres:18-alpine` with a persistent disk mounted at
  `/var/lib/postgresql`, and `POSTGRES_USER`/`POSTGRES_PASSWORD`/`POSTGRES_DB` set. You are then the
  superuser, and the roles of section 3 can be created (through the service's shell).
- You then own what Render would: no point-in-time recovery, so Tilvara's own backups (section 7) are the
  only ones, and must be copied off Render; version upgrades and disk size are yours. A disk also pins
  the service to one instance with downtime on every deploy of it.
- Point the connection strings at the private service's internal host.

This is a staging compromise. Before production, choose a database service that allows these roles
(the decision D1 in ADR-0016 covers it).

## 9. Monitoring

The API and worker serve `/metrics` on ports 4329 and 4339 with the bearer token `METRICS_TOKEN`. Render
exposes only `PORT` to the internet, so those ports are reachable from Render's private network only. To
use the alert rules (`infra/monitoring/alerts.yml`), run Prometheus as a private service in the same
region scraping `<internal host>:4329` and `:4339`, or start with Render's own service metrics and log
streams. Logs are JSON on stdout; Render's log view and log streams carry them as they are.
