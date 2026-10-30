# Aegis Consumer Proof #2

A small, product-agnostic multi-tenant SaaS application built to exercise a second
consumer-proof shape: a real build step, a test suite, one schema migration, one
auth boundary, role separation (member vs admin), a feature-flagged capability, and
two synthetic tenants.

**Status:** repository initialized; the build starts when the deployment secrets and
the owner-run Codex cold-start transcript exist. No code, workflow or deploy is
present yet.

**Product-agnostic firewall.** Everything in this repository is synthetic and
generic. There is no real user, no real data, no payment provider, and no
third-party product name, code, schema, copy or naming. Tenants are named
`tenant-a` and `tenant-b`; roles are `member` and `admin`; the flagged capability is
a generic feature flag. Any contribution that would bring product-specific names,
schemas or code into this repository is out of scope.

**License.** Apache-2.0. See `LICENSE` and `NOTICE` (upstream Project Aegis
attribution).
