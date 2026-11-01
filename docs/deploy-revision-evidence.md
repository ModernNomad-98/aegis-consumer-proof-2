# Deploy revision and review-evidence recovery (Proof #2)

Status: **docs-only recovery revision prepared 2026-11-01. Not merged, not deployed,
no readiness claim.** This file records why a new revision is needed and the exact
ordering that must be followed so the merged deploy gate can accept genuine
pre-merge review evidence - without backdating, editing or bypassing the gate.

## Why a new revision

The merged product pull request #6 (reviewed head `c019b22481497e0e2ed6adf0f5bb066db331bee0`,
merge commit `0e1085e7dcb07bdc6206f685fc28f22b9f3d5bf5`, second parent `c019b22...`,
tree `bdd4e4f8386281a3a8325865fb975ca56193adb9`) is not deployable through the
merged deploy gate: the gate requires a machine-readable owner-account review-evidence
comment created **before** the merge (`merged_at`). PR #6 recorded review verdicts
but zero whole-line evidence markers and zero formal reviews, so the merged gate
correctly ends `E_REVIEW_NONE` for that merge, and its ordering control denies every
post-merge repair (creating, editing or backdating evidence after the merge is
`E_REVIEW_ORDER`). Recovery analysis: `DEPLOY-GATE-EVIDENCE-RECOVERY-2026-10-30.md`,
32,842 B, sha256 `42bee4fb2b654f672617265b4a0e2a22fb58080575d13a2cb9f7969c2dff7af8`;
owner-selected **Option A** (owner comment 6559320969).

## What this revision is

One docs-only change on top of current `main` `0e1085e7dcb07bdc6206f685fc28f22b9f3d5bf5`
(tree `bdd4e4f8386281a3a8325865fb975ca56193adb9`). It creates a new reviewable merge
revision whose product bytes are the already-reviewed bytes of PR #6 plus this
documentation delta. It changes **no** workflow, deploy gate, policy, setting, secret,
credential, product runtime or dependency.

## Required ordering (must not be reordered)

1. **Freeze** this pull request's exact head `H'` and exact body bytes; record the
   body sha256. The body must not change after this freeze.
2. A **fresh independent different-vendor review** (not the builder's vendor, and not
   the DeepSeek author/review lane) posts PASS/ACCEPT bound to the exact `H'` and
   body sha256. It does not post the owner-account machine-evidence block.
3. The **owner account** then posts the D-G2 machine-evidence comment bound to `H'`
   and the exact body sha256, **before** the merge.
4. CI (`reproduce` at `H'`) is green; a **fresh merger** (not author/reviewer)
   merges with "Create a merge commit" while the pull request is up to date with
   `main`, using `--match-head-commit H'`, and posts the receipt within 15 minutes.
5. **Nobody edits any owner comment that existed before that merge afterwards** - the
   ordering rule denies `E_REVIEW_ORDER` on any post-merge edit of a pre-merge owner
   comment, even ordinary chat.
6. The owner re-confirms the first-deploy prerequisites in `README.md` (Render
   target/health, Neon runtime-role SQL/grants, Render environment removal/rotation,
   the recorded three connectivity PASS runs) and gives the **owner deploy line**
   (deployment to a live URL remains owner-reserved).
7. The owner dispatches "Deploy reviewed revision" from `main` with this pull
   request's number **while `main` still points at this pull request's merge commit
   `M'`**. The merged gate verifies `M'` -> `H'` (second parent plus strict tree
   equality), the exact-head push CI at `H'`, and the pre-merge owner evidence
   comment, then runs the deploy checks.

## What the deploy gate verifies at dispatch

- The dispatched commit `M'` is this pull request's merged merge commit and its
  second parent is exactly the reviewed head `H'`.
- `tree(M') == tree(H')` exactly (strict tree equality, no disjoint fallback).
- The latest exact-head `push` run of the committed `reproduce` workflow at `H'` is
  completed and green.
- A pre-merge owner-account review-evidence comment binds `H'` and the exact body
  hash, with reviewer/builder model declarations that differ after normalization.
- No owner comment that existed at merge time was edited after the merge.

## Limits (recorded, not hidden)

- Review evidence in this repository is agent-posted under the solo-owner D-G2
  limitation: there is no second human account, so the evidence is self-asserted
  review evidence, not a second-account approval.
- The deploy gate's positive path has never been exercised end-to-end; the first
  deploy is its first real exercise and remains owner-held. No first-deploy readiness
  claim is made.
- If `main` advances between this pull request's merge and the deploy dispatch, the
  gate denies (fail closed) and a further revision is required.
- This revision makes no deployment, dispatch, hosted-database contact, credential use
  or setting change.
