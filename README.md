# Tenant workspace

A small synthetic multi-tenant web application: Node 22, TypeScript, Fastify and
PostgreSQL 16 or newer. Members read their tenant's records; admins add records and
view reports when enabled by configuration. No real users, real data or payment
system.

**Delivery status: single local-first replacement candidate for Proof #2.** This
branch carries the product build from the earlier review candidate (branch
`codex/proof2-build` at `f97484035eb63d23ee647bb7b0106dd1bc983b61`, never merged)
rebased onto `main` after the connectivity workflow landed, plus the
owner-dispositioned fixes O2, O3, O4, D-G1, D-G2 and D-G6. It is one local-first
candidate branch iterated locally before its single pull request (owner decision
D0-4, 2026-10-30 20:50 PDT). Independent review at the exact head, one fresh
merger and one merge receipt follow; **nothing has been deployed and no workflow
has been dispatched**. The two workflow files in this change
(`.github/workflows/ci.yml` and `.github/workflows/deploy.yml`) require the
owner's explicit line under the standing merge authorization because the standing
authorization still names `.github/workflows/**` as an owner-line path.

### Dispositioned fixes against the earlier review candidate

- **O2 - Render health target (owner 2026-10-30 21:02/21:08 PDT).** The confirmed
  Render target is service `proof2-web` (`srv-dbhvbl7b9u1s73b44n2g`), health path
  `/health`, Auto-Deploy OFF, deploy hook as stored.
  `HEALTHCHECK_URL=https://proof2-web.onrender.com/health` is set as a **plain
  workflow env var** in `deploy.yml` - not a secret, not a repository or
  environment variable. `render.yaml` and the `scripts/deploy.mjs` fallback name
  the same `proof2-web` origin.
- **O3 - PostgreSQL major (owner 2026-10-30 21:02 PDT).** `scripts/verify.ts`
  accepts major **16 or newer** and logs the observed server version; the hosted
  database is not downgraded.
- **O4 - runtime role bootstrap (owner 2026-10-30 21:02 PDT).** The owner
  pre-creates `app_runtime` (`NOLOGIN NOSUPERUSER NOBYPASSRLS`) and
  `GRANT app_runtime TO proof2_app` in the Neon console; the migration carries an
  idempotent existence guard for `CREATE ROLE app_runtime` and fails closed if an
  existing `app_runtime` has unsafe attributes. `proof2_migrator` stays
  `NOCREATEROLE`. The existing `GRANT app_runtime TO <runtime identity>` in
  `scripts/migrate.ts` is preserved and already idempotent.
- **D-G1 - deploy gate mapping STRICT (owner 2026-10-30 21:02 PDT).** The deploy
  gate maps a main merge commit to the reviewed pull-request head with **strict
  tree equality, no disjoint fallback**; see "Deploy gate" below.
- **D-G2 - independent review limitation (owner 2026-10-30 21:02 PDT).** See
  "Limitations" below and the review-evidence route in "Deploy gate".
- **D-G6 - workflow/check naming (owner 20:57 PDT, corrected 21:14 PDT).** The
  workflows expose the check contexts the owner's ruleset names: `reproduce`
  (`ci.yml` job, workflow `Verify`) and `SELECT 1 (runtime + migration)`
  (`connectivity.yml` job, already on `main`). No repository setting is changed by
  this branch; the ruleset is owner-run. Operational flag (owner-held):
  `connectivity.yml` is `workflow_dispatch`-only, so requiring its check on pull
  requests is not satisfiable without a pull-request trigger or a check-run
  bridge.

## Run locally

Prerequisites: Node **22.x**, npm and Docker with Compose. Use a disposable local
database. The local credentials below are public synthetic fixtures only.

1. `package-lock.json` is committed, so every install (local, CI and deployment)
   uses `npm ci --ignore-scripts --no-audit --no-fund`.
2. Run `docker compose up -d --wait db`. Initialization creates a restricted
   login separate from the database owner. Do not remove the container if you
   want to retain its local records.
3. Set environment variables in your shell (PowerShell example):

   `powershell
   $env:DATABASE_URL = 'postgres://app_login:local_app_only@localhost:5432/app'
   $env:MIGRATION_DATABASE_URL = 'postgres://migration_login:local_migration_only@localhost:5432/app'
   $env:SYNTHETIC_PASSWORD = 'synthetic-local-password-only'
   $env:SESSION_SECRET = 'synthetic-local-signing-secret-at-least-32-characters'
   $env:APP_ORIGIN = 'http://localhost:3000'
   $env:REPORTS_TENANTS = 'tenant-a'
   npm run reproduce
   npm run dev
   `

   On POSIX shells use `export NAME=value`. `.env.example` documents variables;
   `.env` files are **not automatically loaded**. Never reuse local fixture
   credentials in a hosted environment.
4. Open `http://localhost:3000`. Sign in as `tenant-a-member`,
   `tenant-a-admin`, `tenant-b-member` or `tenant-b-admin`, using the password
   set above.

`npm run reproduce` installs the lockfile, compiles TypeScript, runs units, runs
the deploy-gate test matrix, applies the migration twice, verifies checksum,
server major (>= 16) and RLS/runtime role, seeds synthetic fixtures, and runs real
integration/negative tests. Missing Node 22 or database configuration fails the
runner; it never silently substitutes mocks.

Individual steps: `npm run build`, `npm test`, `npm run test:gate`,
`npm run migrate`, `npm run verify:migration`, `npm run seed`,
`npm run test:integration`. `npm start` runs compiled `dist/src/server.js` from
the repository root; static assets remain in `public/`. Browser
rendering/interaction review remains pending.

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
- The runtime role is the owner-pre-created `app_runtime` group, granted to the
  restricted `proof2_app` login; the migration does not require the migration
  identity to hold CREATEROLE when the owner has already created the group (O4).
  `proof2_migrator` stays `NOCREATEROLE`.
- `REPORTS_TENANTS=tenant-a` enables reports for that tenant's admins; missing
  config disables them. Members remain denied. Changes take effect after restart.
- Maintenance owner policies intentionally permit seeding/inspection. Keep the
  migration credential out of the web service (O5 removes `MIGRATION_DATABASE_URL`
  from Render's runtime env; it remains only a GitHub environment secret).
  Arbitrary SQL access can change context settings and is not a supported API;
  parameterized queries are essential.
- Seed is additive/idempotent and does not rotate existing passwords. Integration
  tests use synthetic accounts, clean their own records/sessions and roll back
  direct negative writes. Never point them at real customer data.

## Render deployment - held for independent review

The deploy workflow is manual-only; `render.yaml` disables automatic deploys.
**Do not create/apply the blueprint or dispatch deployment yet**: creating a
service can start its first deployment, and the first deploy still needs an
explicit owner line.

### Deploy gate mapping (D-G1 STRICT; no disjoint fallback)

`scripts/review-gate.mjs` runs twice: in the unprivileged `review` job and again
immediately before the deploy step. It accepts a dispatch from `main` only when
every one of the following is proven, and otherwise fails closed with one fixed
reason code (`Deployment gate denied: <CODE>`):

1. The dispatch ref is `refs/heads/main` and the checked-out revision is the
   dispatched revision.
2. The supplied pull request is **merged into main** and its `merge_commit_sha` is
   exactly the dispatched commit M.
3. M has exactly two parents and its **second parent is exactly the reviewed
   pull-request head H**.
4. **tree(M) equals tree(H) exactly** - strict tree equality with no disjoint-file
   fallback. This is why the merger must use **"Create a merge commit"** and must
   merge only when the pull request is up to date with `main`; if main advanced
   under the pull request, the gate denies. (The owner's ruleset uses
   `strict_required_status_checks_policy: true`, which requires that up-to-date
   state; if an admin bypass is used the strict tree check still fails closed.)
5. The latest **exact-head push run** of `ci.yml` (`Verify` / `reproduce`) at H is
   completed and green.
6. **Review evidence bound to H** is present, as below.

### Review evidence accepted by the gate

Two forms are accepted:

- **(a) Formal review:** a GitHub `APPROVED` review at H from an account that is
  not the pull request author, has trusted association (OWNER/MEMBER/
  COLLABORATOR) and passes the repository-permission lookup
  (admin/maintain/write; a failed lookup denies this path closed), whose body
  contains the exact line `Reproduce reviewed: <full 40-character H>`. (No
  distinct reviewer account exists today - D-G2 - so this path is dormant and
  untested end-to-end.)
- **(b) Agent review evidence (D-G2 route, no second account):** a pull-request
  conversation comment posted by the **repository owner account** (a User
  account; Bot/Organization comments are never evidence) whose **last edit is
  before the merge** - the gate compares `updated_at` (falling back to
  `created_at`) against `merged_at`, so a comment created before the merge and
  edited after it is rejected. Other GitHub users can comment on this public
  repository; their comments are filtered out **before** the latest-evidence
  selection, so they can neither block nor supersede a deploy. The comment
  contains exactly one block of this form (one field per line):

  `
  Aegis deploy review evidence v1
  verdict: PASS
  reviewed-head: <full 40-character H>
  reviewed-body-sha256: <sha256 of the exact pull-request body bytes>
  reviewer-model: <model that performed the review>
  builder-model: <model that authored the change>
  `

  The gate requires: the marker `Aegis deploy review evidence v1` to be an
  exact whole line; verdict `PASS`; `reviewed-head` equal to H;
  `reviewed-body-sha256` equal to the current pull-request body hash; reviewer
  and builder model declarations present and different after ignoring case,
  punctuation and whitespace (so "DeepSeek-V4" and "DeepSeek V4" cannot pass as
  different vendors). The latest eligible owner block wins. The ordering control
  runs over **all** owner User comments (not only comments that still contain the
  marker) and is **fail-closed**: if any owner comment that existed at merge time
  (`created_at` <= `merged_at`) was edited afterwards (`updated_at` >
  `merged_at`), or an owner marker comment was posted or edited after
  `merged_at`, or an owner timestamp is unparseable, the gate denies
  `E_REVIEW_ORDER` **unconditionally**, even when another owner PASS block is
  still eligible. This also catches a pre-merge `verdict: REVISE` block edited
  after the merge to remove or alter its marker line, so it cannot resurrect an
  older PASS block. Ordinary new owner comments created after the merge do not
  deny. The re-blocking rule applies to the agent-evidence path: the formal
  distinct-account review path is evaluated before owner comments are read (N2
  scope). **Recorded limitations:** the block is self-asserted because all agent
  sessions share one GitHub login (review evidence, not a second-account
  approval); GitHub timestamps are whole-second, so an edit in the same second
  as the merge counts as pre-merge; and deleting an owner evidence comment after
  the merge cannot be detected through the pull-request comments API, so the
  gate only evaluates surviving comments.

### Owner prerequisites before the first deploy

1. Owner "re-set" of the direct-host `DATABASE_URL` / `MIGRATION_DATABASE_URL`
   secrets and three consecutive connectivity PASS runs (recorded as runs
   `41167357725`, `41167392696`, `41167425612` on `main` before this replacement
   candidate).
2. Neon: run the owner SQL `CREATE ROLE app_runtime NOLOGIN NOSUPERUSER
   NOBYPASSRLS; GRANT app_runtime TO proof2_app;` (O4) and remove
   `MIGRATION_DATABASE_URL` from the Render web service, then rotate the
   `proof2_migrator` password (O5). Verify the migration identity can execute
   the preserved idempotent `GRANT app_runtime TO proof2_app` that
   `scripts/migrate.ts` re-issues inside the migration transaction (for example
   by holding ADMIN OPTION on `app_runtime`); otherwise the first hosted
   migration fails closed at that statement. This is an owner prerequisite, not
   a change in this branch.
3. Confirm the Render target `proof2-web` (`srv-dbhvbl7b9u1s73b44n2g`), health
   path `/health`, Auto-Deploy OFF, and that the stored deploy hook belongs to
   that service (O2).
4. Owner line for the first deploy: deployment/paid dispatch remains an
   owner-reserved action even after merge.

### Deployment steps

1. **Post the review evidence (a) or (b) above BEFORE merging**, bound to the
   reviewed head H and the exact pull-request body. Agent evidence (b) must be
   created and last edited before the merge: the gate compares `updated_at`
   (falling back to `created_at`) with `merged_at`. Do not edit ANY owner comment
   that existed before the merge after merging - removing or altering the marker
   line still denies the gate even if another owner PASS block is eligible; new
   post-merge owner comments are fine.
2. Merge this pull request with **"Create a merge commit"** while it is up to
   date with `main` (strict tree equality requires M's tree to equal the reviewed
   head's tree).
3. Dispatch `Deploy reviewed revision` from `main`, entering the merged
   pull-request number. The environment `proof2-deploy` (id `25749368568`,
   main-only branch policy `64859958`) stays main-only.
4. The workflow builds, runs units and the deploy-gate matrix, applies/verifies
   migration, seeds the synthetic database, runs auth/RLS negatives, rechecks the
   gate immediately before deploying, triggers the exact revision through the
   stored hook and polls `https://proof2-web.onrender.com/health` for both
   `status=ok` and the matching deployed revision, with a timeout. An older
   healthy instance cannot satisfy the smoke check.

A migration failure rolls back its transaction. If deployment/smoke fails, stop
and inspect privately; preserve data and forward-fix or redeploy a previously
approved compatible revision. No automatic destructive down migration, credential
provisioning or cleanup exists. Initial release has no prior application version;
disable service on failure. Local database reset deliberately loses synthetic
data.

### Required checks (owner ruleset, owner-run)

The owner's ruleset names check contexts `reproduce` and
`SELECT 1 (runtime + migration)`. This repository exposes them as the CI job
`reproduce` (workflow `Verify`) and the connectivity job
`SELECT 1 (runtime + migration)` (workflow `Connectivity gate (SELECT 1)`). The
owner applies the ruleset; agents do not change repository settings. Operational
flag: the connectivity workflow is dispatch-only, so as a required pull-request
check it is not satisfiable without a pull-request trigger or a check-run bridge;
`reproduce` is the PR-triggered check.

Implementation references: [cookie signing](https://github.com/fastify/fastify-cookie),
[PostgreSQL 16 policies](https://www.postgresql.org/docs/16/sql-createpolicy.html),
[Render exact-commit hooks](https://render.com/docs/deploy-hooks).

## Limitations

- **Solo owner; no second human account (D-G2, owner 2026-10-30 21:02 PDT).**
  Independent review for this repository is **agent-only, from a different vendor
  than the builder**; that agent review is the formal review for this repository.
  There is no second human account and the GitHub account is shared by all agent
  sessions. This is the same recorded limitation as Proof #1. The deploy gate's
  agent-review evidence is therefore self-asserted by the owner account (see
  "Review evidence" above), and review independence is enforced by process
  (different session/vendor), not by account separation.
- The deploy gate's **positive path has never been exercised end-to-end**; only
  the deny path and the offline test matrix are proven. The first real deploy
  remains owner-held.
- Evidence-ordering controls are whole-second and comment-history only: an edit
  in the same second as the merge counts as pre-merge; any owner comment that
  existed at merge time and was edited afterwards denies (the marker does not
  need to survive the edit); deletion of an owner comment after the merge is not
  detectable through the pull-request comments API (the gate evaluates surviving
  comments); and the formal distinct-account review path is evaluated before
  owner comments, so the owner-REVISE re-blocking rule applies to the
  agent-evidence path only (N2 scope).
- Browser rendering/interaction review remains outstanding. No signup,
  reset/MFA, distributed rate limiter, session-cleanup scheduler, tenant
  offboarding or operational backup/restore automation exists.
- The earlier review candidate's delivered documentation (`docs/agent-notes.md`,
  `docs/implementation-report.md`) is preserved unchanged as the cold-start
  record; its status statements are historical and superseded by this README.

## Tests and limits

Tests cover bad credentials, unauthenticated/tampered/expired sessions, cookie
attributes, logout revocation, role denial, hostile origins, body tenant
injection, cross-tenant reads, SQL read/write denials, tenant hopping, positive
controls and pooled context reset. Integration uses real handlers, scrypt and
PostgreSQL, no mocks. The deploy-gate test matrix (`tests/review-gate.test.mjs`)
builds real temporary git repositories and mocked GitHub evidence to prove the
strict merge/tree mapping, the review-evidence bindings and every fail-closed
reason code; it runs in `npm run reproduce` and therefore in the `reproduce` CI
job.

Apache-2.0. Existing skill-library attribution remains in `LICENSE` and `NOTICE`.
