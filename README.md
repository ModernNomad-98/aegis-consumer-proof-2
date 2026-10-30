# Tenant workspace

A small synthetic multi-tenant web application: Node 22, TypeScript, Fastify and
Postgres 16. Members read their tenant's records; admins add records and view
reports when enabled by configuration. No real users, real data or payment system.

**Delivery status:** review candidate on branch `codex/proof2-build`. The original
Codex build ran in a read-only sandbox (no Git writes, no npm registry, no
Postgres). The fresh builder (DeepSeek V4 Flash, DeepSeek Harness) committed the
delivered tree, generated and committed `package-lock.json`, fixed one TypeScript
error in the request error handler, and ran `npm ci`, `npm run build`, `npm test`
and the full `npm run reproduce` gate under Node 22.23.4 against a real disposable
PostgreSQL 16.10. Independent review, merge and deployment are still outstanding;
nothing has been deployed. The [agent notes](docs/agent-notes.md) are the cold-start
record; their validation section describes that read-only sandbox and is superseded
by this status.

## Run locally

Prerequisites: Node **22.x**, npm and Docker with Compose. Use a disposable local
database. The local credentials below are public synthetic fixtures only.

1. In a writable checkout, switch to the candidate branch:
   `git switch codex/proof2-build`.
2. `package-lock.json` is committed, so every install (local, CI and deployment)
   uses `npm ci --ignore-scripts --no-audit --no-fund`.
3. Run `docker compose up -d --wait db`. Initialization creates a restricted
   login separate from the database owner. Do not remove the container if you
   want to retain its local records.
4. Set environment variables in your shell (PowerShell example):

   ```powershell
   $env:DATABASE_URL = 'postgres://app_login:local_app_only@localhost:5432/app'
   $env:MIGRATION_DATABASE_URL = 'postgres://migration_login:local_migration_only@localhost:5432/app'
   $env:SYNTHETIC_PASSWORD = 'synthetic-local-password-only'
   $env:SESSION_SECRET = 'synthetic-local-signing-secret-at-least-32-characters'
   $env:APP_ORIGIN = 'http://localhost:3000'
   $env:REPORTS_TENANTS = 'tenant-a'
   npm run reproduce
   npm run dev
   ```

   On POSIX shells use `export NAME=value`. `.env.example` documents variables;
   `.env` files are **not automatically loaded**. Never reuse local fixture
   credentials in a hosted environment.
5. Open `http://localhost:3000`. Sign in as `tenant-a-member`, `tenant-a-admin`,
   `tenant-b-member` or `tenant-b-admin`, using the password set above.

`npm run reproduce` installs the lockfile, compiles TypeScript, runs units, applies
the migration twice, verifies checksum and RLS/runtime role, seeds synthetic
fixtures, and runs real integration/negative tests. Missing Node 22 or database
configuration fails the runner; it never silently substitutes mocks.

Individual steps: `npm run build`, `npm test`, `npm run migrate`,
`npm run verify:migration`, `npm run seed`, `npm run test:integration`.
`npm start` runs compiled `dist/src/server.js` from the repository root; static
assets remain in `public/`. Browser rendering/interaction review remains pending.

## Data and security

- One initial migration: `migrations/001_initial.sql`. Records use a leading
  tenant key and forced RLS. Accounts/sessions use narrower identity/token
  policies and forced RLS. No request uses the migration connection.
- Passwords use Node scrypt with random salt (`N=32768`, `r=8`, `p=3`). Cookies
  contain signed random opaque tokens; only SHA-256 token hashes are stored.
  Sessions expire after one hour; logout deletes the database row. Hosted cookies
  are Secure, HttpOnly and SameSite=Strict. Mutations require exact `APP_ORIGIN`.
- Tenant context comes from authenticated membership, using transaction-local
  settings on one connection. Headers, URLs and body tenant selectors grant no
  authority. Runtime credentials must not be superuser, BYPASSRLS, CREATEROLE or
  a member of a table-owner role.
- `REPORTS_TENANTS=tenant-a` enables reports for that tenant's admins; missing
  config disables them. Members remain denied. Changes take effect after restart.
- Maintenance owner policies intentionally permit seeding/inspection. Keep the
  migration credential out of the web service. Arbitrary SQL access can change
  context settings and is not a supported API; parameterized queries are essential.
- Seed is additive/idempotent and does not rotate existing passwords. Integration
  tests use synthetic accounts, clean their own records/sessions and roll back
  direct negative writes. Never point them at real customer data.

## Render deployment — held for independent review

The workflow is manual-only; `render.yaml` disables automatic deploys.
**Do not create/apply the blueprint or dispatch deployment yet**: creating a service
can start its first deployment. The lockfile is committed and the Node 22 / Postgres
16 reproduce run passes locally on this head, but independent review of the exact
commit has not happened, and the environment constraint in step 5 blocks dispatch.

Eventual operator setup:

1. Provision a dedicated synthetic Postgres **16** database with separate runtime
   and migration logins. The migrator needs role creation/grant authority. Configure
   verified TLS settings; scripts never disable certificate validation. Verify
   that CI can reach the database.
2. Use the protected `proof2-deploy` environment (id `25749368568`, main-only
   branch policy `64859958`) with required reviewers. Existing secrets, by name:
   `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `RENDER_DEPLOY_HOOK_URL`. URLs are
   never echoed. There is deliberately **no** `SYNTHETIC_PASSWORD` secret: the
   deploy workflow uses a labelled non-secret synthetic fixture constant, because
   the only rows it writes are disposable synthetic fixtures. `HEALTHCHECK_URL` is
   an optional repository/environment variable; when it is unset or empty,
   `scripts/deploy.mjs` falls back to the documented default
   `https://tenant-workspace.onrender.com/health` (Render service name from
   `render.yaml`) and rejects any `https` URL whose path is not `/health`.
3. The web service receives only restricted `DATABASE_URL`, random `SESSION_SECRET`
   (at least 32 characters), exact HTTPS `APP_ORIGIN`, `NODE_ENV=production`, and
   optional `REPORTS_TENANTS`. The blueprint generates a session secret. Do not
   supply the migration credential to the web service.
4. Push the candidate and open a PR. A trusted independent reviewer, not the PR
   author, must approve the exact head and include
   `Reproduce reviewed: <full 40-character commit>` in the approval body after
   examining the committed runner and green `Verify` workflow. No approval record
   is supplied or fabricated by this implementation.
5. Dispatch `Deploy reviewed revision` from `main`, entering the PR number.
   **Known constraint, deliberately unresolved here:** the `proof2-deploy`
   environment allows `main` only, while the gate requires `github.sha` to equal
   the pull-request head. Dispatching at a merge commit on `main` therefore makes
   `scripts/review-gate.mjs` deny the run (fail closed) because the PR head and the
   merged commit differ. Deployment stays blocked until the owner either widens the
   environment branch policy or approves a gate change that maps an approved head
   to its merge commit; the gate is intentionally not weakened. The gate checks
   committed runner/lockfile/workflow, latest successful exact-head push CI,
   independent approval and outstanding change requests. Missing/inaccessible
   evidence denies deployment. Any head update requires fresh CI and approval.
6. After review gating, the workflow builds, runs units, applies/verifies migration,
   seeds the synthetic database and runs auth/RLS negatives. It rechecks review,
   triggers the exact commit's hook and polls health for both `status=ok` and the
   matching `RENDER_GIT_COMMIT`, with a timeout. An older healthy instance cannot
   satisfy the smoke check.

A migration failure rolls back its transaction. If deployment/smoke fails, stop
and inspect privately; preserve data and forward-fix or redeploy a previously
approved compatible revision. No automatic destructive down migration, credential
provisioning or cleanup exists. Initial release has no prior application version;
disable service on failure. Local database reset deliberately loses synthetic data.

Implementation references: [cookie signing](https://github.com/fastify/fastify-cookie),
[Postgres 16 policies](https://www.postgresql.org/docs/16/sql-createpolicy.html),
[Render exact-commit hooks](https://render.com/docs/deploy-hooks).

## Tests and limits

Tests cover bad credentials, unauthenticated/tampered/expired sessions, cookie
attributes, logout revocation, role denial, hostile origins, body tenant injection,
cross-tenant reads, SQL read/write denials, tenant hopping, positive controls and
pooled context reset. Integration uses real handlers, scrypt and Postgres, no mocks.

This synthetic demonstration has no signup, reset/MFA, distributed rate limiter,
session-cleanup scheduler, tenant offboarding or operational backup/restore
automation. Independent security review and browser rendering/interaction review
remain outstanding. The build, unit tests, migration/verification, seeding and real
Postgres auth/RLS integration tests pass locally on this head under Node 22.23.4
with PostgreSQL 16.10 (see the pull request for exact commands and output).

Apache-2.0. Existing skill-library attribution remains in `LICENSE` and `NOTICE`.
