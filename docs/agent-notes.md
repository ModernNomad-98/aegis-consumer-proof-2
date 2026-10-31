# Implementation notes

Actor: Codex, GPT-6-based implementation agent. Source skill revision: `f16179101f526df79eb3202c4bed3d0c871b8ede` (initial checkout, `git log -1 --format=%H`).

## Preflight and scope

The README identifies a fresh consumer product. `Test-Path` returned false for `docs/skills-catalog.md`, `scripts/validate-skills.py` and `artifacts/audits/skill-contract-audit-baseline.json`. This is Role B; copied source-library merge grants do not apply. The local skill directories are the available catalog. No source-library files were changed.

The user authorized app, schema, security, tests, documentation and deployment-workflow implementation, but prohibited deployment before independent reproduce review. No live service, database or deploy hook was contacted. Scope: `src/`, `public/`, `migrations/`, `scripts/`, `tests/`, `docs/`, package/build files, local compose and deployment configuration. Governing risk: authentication and RLS, requiring real negative tests and independent review before release.

## Skills consulted as work progressed

| Skill and source revision | Actor / role | Purpose | How applied | Result, evidence, and limitations |
| --- | --- | --- | --- | --- |
| `multi-tenant-data-architect`, `.claude/skills/multi-tenant-data-architect/SKILL.md` at source revision above | Codex / implementation planning | Tenant data ownership and context | Read skill and scoping-strategy reference; defined pooled store and transaction-local context | One database; tenant records use session-derived scope; no secondary stores. See design below and `src/db.ts`. |
| `integration-test-designer`, `.claude/skills/integration-test-designer/SKILL.md` at source revision above | Codex / test planning | Real dependency boundary tests | Read skill and boundary catalog; specified real HTTP-handler, session, KDF, SQL and role paths | `tests/integration.test.ts`; no database/auth mocks. Execution blocked by environment, not replaced with mocked integration. |
| `change-classification-gate`, `.claude/skills/change-classification-gate/SKILL.md` at source revision above | Codex / scope assessment | Set validation and authority boundaries | Read complete skill and classification matrix; classified mixed backend, UI, schema/security, QA and cloud configuration scope | Current user request authorizes implementation. Deployment remains gated; validation gaps below prohibit a ready claim. |
| `authentication-flow-reviewer`, `.claude/skills/authentication-flow-reviewer/SKILL.md` at source revision above | Codex / design self-check | Session lifecycle and denial cases | Read complete skill and flow matrix reference; mapped login, rotation, expiry and logout | Flow table below; implementation tests authored. This is self-check, not independent review. |
| `feature-flag-architect`, `.claude/skills/feature-flag-architect/SKILL.md` at source revision above | Codex / design | Server-side config flag | Read complete skill and flag-system reference; used user's config-only decision | `src/flags.ts`: explicit tenant allowlist, false default; no provider/cache/override service. Distributed-service machinery is outside this small config-only task. |
| `schema-evolution-planner`, `.claude/skills/schema-evolution-planner/SKILL.md` at source revision above | Codex / applicability assessment | Migration sequencing | Read complete skill and stage reference | Initial additive schema only; no live shape to evolve, backfill or contract. Migration precedes first app start. |
| `rls-policy-auditor`, `.claude/skills/rls-policy-auditor/SKILL.md` at source revision above | Codex / policy author and self-check | Policy text and per-command negatives | Read complete skill and checklist; inspected initial SQL, runtime grants and context propagation | Forced RLS on all data/auth tables; no SECURITY DEFINER helpers; tests cover read/write/hop denial. Not independently audited or database-verified. |
| `secure-migration-reviewer`, `.claude/skills/secure-migration-reviewer/SKILL.md` at source revision above | Codex / migration self-check | Deploy order, privileges, rollback | Read complete skill; inspect up SQL and rollback plan below | No-go for deployment until real tests and independent review. Maintenance owner intentionally privileged and excluded from request pool. |
| `appsec-implementer`, `.claude/skills/appsec-implementer/SKILL.md` at source revision above | Codex / selection only | Check implementation skill applicability | Read description and workflow | MANUAL-ONLY: not invoked. Implementation follows direct user task authority; no claim of red/green skill execution. |

Manual-only test, pipeline and implementation skills were not auto-invoked. Design skills supplied guidance only; file writes and local checks are separate actions authorized by the user's implementation request.

## Design and pre-implementation check

Tenant means one synthetic workspace, identified by `tenant-a` or `tenant-b`. Every account belongs to exactly one tenant. There is no tenant switching, signup or membership administration. Member: read own tenant records. Admin: read/create own tenant records and read reports when the flag permits. Neither role crosses tenants. The browser never chooses database context.

Store inventory: Postgres only. `records` are tenant-owned; `accounts` and `sessions` are protected identity/control-plane tables. The authentication component owns the latter; the record component owns records. Accounts contain tenant membership but expose only the exact login lookup or current user; they have no runtime mutation grant. Sessions expose only the current opaque token hash. Tenant key leads the records primary key. No scale or partitioning claim is made.

Login lookup is deliberately pre-authentication: an exact bounded username is permitted to select one password hash inside server code. Only successful KDF verification issues a session. There is no generic SQL endpoint. Session-token possession establishes user identity, then tenant context. SQL injection remains a critical trust boundary: parameterized queries and no raw client-controlled SQL are required; RLS is defense in depth, not protection from arbitrary compromised-server SQL.

Auth flow: login -> generic failure or new random session (one hour absolute expiry); re-login -> prior browser session deleted and new token; logout -> server row deletion and cleared cookie; expired/tampered/unknown token -> 401. Each request reloads membership/role. No refresh, reset, MFA, federation, account linking or device trust is implemented in this synthetic scope. Recovery is re-login; fixture password changes are an explicit maintenance action. Login is rate-limited per process/IP; multi-instance shared throttling is a future production concern. Origin validation and Strict SameSite protect mutations; HttpOnly prevents script access; Secure is required in hosted production. No credential logging.

Reports: single server-side config `REPORTS_TENANTS`, owner = repository operator, added 2026-10-30, review date 2026-11-30, safe default false. Changes require an operator config update/restart, audited by the hosting platform; no instant propagation bound is claimed. Admin role is checked separately. No pricing or entitlement system exists.

Migration: one additive SQL file, checksummed in a ledger; advisory transaction lock prevents concurrent migration races. Lock timeout 10 seconds, statement timeout 60 seconds. Only fresh isolated synthetic databases are supported. Runtime login must preexist and be separate from migrator; migrator needs role creation/grant authority. Maintenance policies permit the migration owner to seed and inspect fixtures. `assertRuntime` rejects superuser, BYPASSRLS, CREATEROLE and membership in table owners. Application runtime never reads `MIGRATION_DATABASE_URL`.

Rollback: a failing migration transaction rolls back completely. After success, stop traffic and retain the additive schema when rolling application code back. Initial release has no earlier application version; disable service if smoke fails, preserve data and forward-fix. Do not automatically drop schema or roles. Recreating a disposable local database loses all its synthetic records and is a separate explicit operator action. Hosted restoration/cleanup is not performed by these scripts. Lifecycle suspend/offboard/purge APIs and backup deletion are outside this synthetic demo; do not reuse it for real tenant data without that work.

Pre-implementation plan check: server authority before tenant query; separate runtime/migrator identities; real DB tests, including negative writes and positive controls; checksum/idempotency verification; exact-commit health check so an old healthy instance cannot satisfy deploy. No payment/user/third-party-product data domain added. Framework and requested hosting technology names are infrastructure dependencies, not copied product vocabulary.

## Validation record

- `git switch -c codex/proof2-build`: failed, `.git` is read-only (`cannot lock ref ... unable to create directory`). Branch and commit not delivered.
- `node --version`: `v24.19.0`; `npm.cmd --version`: `11.17.0`. Required Node 22 unavailable in this shell.
- `docker version`: daemon unavailable. No Postgres container was started.
- `npm.cmd install --cache .npm-cache --ignore-scripts --no-audit --no-fund`: registry fetches failed `EACCES`; stopped after repeated failures. No lockfile or dependencies obtained. Do not describe `npm ci`, build or integration as green.
- Reproduce runner enforces Node 22 and real Postgres 16 verification and never skips missing integration dependencies. It requires a generated, committed `package-lock.json` before CI/deploy can pass.
- `node --check` over `src/`, `scripts/`, `tests/`, and `public/`: PASS for 14 JavaScript/TypeScript source files. This is parsing, not TypeScript type-checking.
- Dependency-free fallback: used Node 24 `stripTypeScriptTypes` on `tests/unit.test.ts`, changed only import suffixes to `.ts` in ignored `test-results/unit.test.mjs`, then ran `node --test test-results/unit.test.mjs`: 2 passed, 0 failed, 0 skipped. This exercises the actual password/flag modules but is NOT Node 22 build or reproduce evidence. The first inline-shell attempt failed quoting; the corrected stdin-script attempt produced these results.
- `node scripts/reproduce.mjs`: correctly refused the installed Node 24 (`Reproduce requires Node 22`). No green reproduce claim.
- `node scripts/review-gate.mjs` without review credentials: correctly denied deployment before any provider call. Positive review-gate/provider integration remains untested.
- `git diff --check`: passed for tracked changes; newly created files are untracked and require separate source review.
- Independent review has not occurred. No PR, push, merge or deployment was attempted.

See README for exact reproduction and reviewer handoff. Source changes are an uncommitted implementation candidate, not a deploy-ready release.
