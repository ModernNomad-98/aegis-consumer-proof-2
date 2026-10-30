# Implementation report

Implemented by Codex (GPT-6-based implementation agent), 2026-10-30.

Source candidate includes a generic web UI and Fastify API; two synthetic tenants;
member/admin enforcement; server-configured reports; scrypt password hashing;
signed HttpOnly cookies with revocable database sessions; one forced-RLS migration;
unit/integration tests; TypeScript build configuration; local Compose setup;
reproduce runner; and a review-gated Render workflow with exact-revision health smoke.

**Verified locally:** syntax parsing of 14 source files; two password/flag unit tests
under Node 24 using built-in type stripping; reproduce rejects the wrong Node major;
deployment gate rejects missing evidence. No credentials or deploy hook were used.

**Blocked/unverified:** Node 22 build, package lock generation, Postgres 16 integration,
browser interaction, independent review and deployment. npm registry requests were
denied (`EACCES`); Docker daemon unavailable; only Node 24 installed.

**Git delivery blocked:** `.git` is mounted read-only. Creation of
`codex/proof2-build` failed; files remain uncommitted on `main`. No lockfile exists.
Do not deploy this candidate. A writable, dependency-enabled environment must
generate/commit the lockfile, run `npm run reproduce`, address any failures, and
obtain independent exact-head review before deployment.

The full required skill-use record, design rationale, migration rollback and
validation limitations are in [agent-notes.md](agent-notes.md). Local setup and
review/deployment steps are in [README.md](../README.md).
