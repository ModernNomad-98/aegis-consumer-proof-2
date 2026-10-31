#!/usr/bin/env node
// Deployment review gate (D-G1 STRICT, owner dispositions 2026-10-30 21:02/21:08 PDT).
//
// The deploy workflow is dispatch-only and runs from protected main; a GitHub
// merge commit therefore has a different SHA from the reviewed pull-request head.
// This gate accepts that dispatch only when it can prove the deployed bytes are
// exactly the reviewed bytes, using the STRICT tree-equality mapping (no
// disjoint fallback):
//
//   M = GITHUB_SHA, the commit being deployed (dispatch from refs/heads/main)
//   H = the merged pull request head SHA (the reviewed revision)
//   (1) M is the checked-out dispatch revision and refs/heads/main was dispatched
//   (2) M is the PR real merge_commit_sha; the PR is merged into main
//   (3) M has exactly two parents and the second parent is exactly H
//   (4) tree(M) == tree(H) exactly (strict; any main-side divergence denies)
//   (5) exact-head CI at H is completed and green for the committed runner
//   (6) review evidence is bound to H:
//       (a) a formal APPROVED GitHub review at H from a trusted account that is
//           not the PR author, containing the exact line
//           "Reproduce reviewed: <H>"; or
//       (b) per owner decision D-G2 (solo owner, no second human account), a PR
//           conversation comment from the repository owner account containing an
//           exact "Aegis deploy review evidence v1" block that binds H and the
//           exact bytes of the PR body, and that declares a reviewer model
//           different from the builder model. Recorded limitation: the evidence
//           block is self-asserted because all agent sessions share one GitHub
//           login; it is review evidence, not a second-account approval.
//
// Fail closed: every check returns a fixed reason code; the CLI prints only
// "Deployment gate denied: <CODE>" and exits 1. The token, request/response
// bodies, git stderr, environment and secret values are never printed.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const REVIEW_EVIDENCE_MARKER = 'Aegis deploy review evidence v1';

export const REASON_CODES = Object.freeze({
  GATE_OK: 'all strict deploy-mapping conditions verified',
  E_ENV_INPUT: 'missing or malformed gate input',
  E_REF_NOT_MAIN: 'the dispatch ref is not refs/heads/main',
  E_GIT_UNAVAILABLE: 'git history is unavailable (a full-history checkout is required)',
  E_GIT_DISPATCH_MISMATCH: 'the checked-out revision is not the dispatched revision',
  E_REQUIRED_ARTIFACTS: 'a required committed artifact is missing from the deployed tree',
  E_EVIDENCE_LOOKUP: 'the GitHub API evidence lookup failed',
  E_PR_NOT_FOUND: 'the review pull request was not found',
  E_PR_NOT_MERGED: 'the review pull request is not merged',
  E_PR_BASE_BRANCH: 'the review pull request was not merged into main',
  E_PR_BASE_REPO: 'the review pull request base repository is not this repository',
  E_PR_HEAD_IDENTITY: 'the review pull request head identity is not this repository',
  E_MERGE_COMMIT_MISMATCH: 'the dispatched revision is not the review pull request merge commit',
  E_PARENT_COUNT: 'the dispatched merge commit does not have exactly two parents',
  E_SECOND_PARENT_MISMATCH: 'the merge commit second parent is not the reviewed head',
  E_STRICT_TREE_MISMATCH: 'tree(merge commit) is not exactly tree(reviewed head)',
  E_REVIEW_PAGINATION: 'review evidence pagination exceeded the hard guard',
  E_REVIEW_NONE: 'no qualifying review evidence is bound to the reviewed head',
  E_REVIEW_MARKER: 'the review evidence marker is malformed or bound to another head',
  E_REVIEW_REVISE: 'the latest agent review evidence verdict is not PASS',
  E_REVIEW_BODY: 'the reviewed body hash does not match the current pull request body',
  E_REVIEW_INDEPENDENCE: 'the review evidence does not separate reviewer and builder models',
  E_REVIEW_ORDER: 'the review evidence postdates the merge',
  E_REVIEW_SELF: 'the only approval at the reviewed head is the pull request author',
  E_REVIEW_NOT_TRUSTED: 'the review evidence was not posted by the repository owner account',
  E_REVIEW_TRUST_UNVERIFIED: 'the trusted-reviewer permission lookup could not be verified',
  E_CHANGES_REQUESTED: 'a trusted reviewer has an unresolved change request',
  E_CI_MISSING: 'no committed-runner CI run exists at the reviewed head',
  E_CI_HEAD_MISMATCH: 'the CI evidence is not bound to the reviewed head',
  E_CI_NOT_GREEN: 'the latest committed-runner CI run at the reviewed head is not green',
  E_INTERNAL: 'unexpected gate failure',
});

const HEX40 = /^[a-f0-9]{40}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;
const DIGITS = /^\d+$/;
const EVIDENCE_MODEL = /^[A-Za-z0-9][A-Za-z0-9 ._+\/-]{1,63}$/;
const FORMAL_REVIEW_MARKER = /^Reproduce reviewed: ([a-f0-9]{40})$/m;
const REQUIRED_ARTIFACTS = [
  'scripts/reproduce.mjs',
  'scripts/review-gate.mjs',
  'package-lock.json',
  '.github/workflows/ci.yml',
];

export class GateError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GateError';
    this.code = code;
  }
}

function requireCode(condition, code) {
  if (!condition) throw new GateError(code);
}

export function parseInputs(env) {
  const source = env || {};
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, GITHUB_REF, REVIEW_PR } = source;
  requireCode(
    typeof GITHUB_TOKEN === 'string' && GITHUB_TOKEN.length > 0
      && REPOSITORY.test(GITHUB_REPOSITORY || '')
      && HEX40.test(GITHUB_SHA || '')
      && DIGITS.test(REVIEW_PR || ''),
    'E_ENV_INPUT',
  );
  requireCode(GITHUB_REF === 'refs/heads/main', 'E_REF_NOT_MAIN');
  return {
    token: GITHUB_TOKEN,
    repository: GITHUB_REPOSITORY,
    dispatchSha: GITHUB_SHA,
    ref: GITHUB_REF,
    reviewPr: REVIEW_PR,
  };
}

export function createGit(cwd) {
  const directory = cwd || process.cwd();
  return (args) => execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function sha256(text) {
  return createHash('sha256').update(text || '', 'utf8').digest('hex');
}

async function githubGet(inputs, path, fetchImpl) {
  let response;
  try {
    response = await fetchImpl('https://api.github.com/repos/' + inputs.repository + '/' + path, {
      headers: {
        Authorization: 'Bearer ' + inputs.token,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new GateError('E_EVIDENCE_LOOKUP');
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new GateError('E_EVIDENCE_LOOKUP');
  try {
    return await response.json();
  } catch {
    throw new GateError('E_EVIDENCE_LOOKUP');
  }
}

async function paginate(inputs, basePath, fetchImpl) {
  const items = [];
  for (let page = 1; page <= 10; page += 1) {
    const separator = basePath.includes('?') ? '&' : '?';
    const batch = await githubGet(inputs, basePath + separator + 'per_page=100&page=' + page, fetchImpl);
    requireCode(Array.isArray(batch), 'E_EVIDENCE_LOOKUP');
    items.push(...batch);
    if (batch.length < 100) return items;
  }
  throw new GateError('E_REVIEW_PAGINATION');
}

function parseEvidenceBlock(body) {
  if (typeof body !== 'string') return null;
  const lines = body.split(/\r?\n/).map((line) => line.trimEnd());
  if (!lines.includes(REVIEW_EVIDENCE_MARKER)) return null;
  const field = (name) => {
    const prefix = name + ': ';
    const values = lines
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length).trim());
    return values.length === 1 ? values[0] : null;
  };
  const parsed = {
    verdict: field('verdict'),
    reviewedHead: field('reviewed-head'),
    reviewedBodySha256: field('reviewed-body-sha256'),
    reviewerModel: field('reviewer-model'),
    builderModel: field('builder-model'),
  };
  return Object.values(parsed).every((value) => typeof value === 'string' && value.length > 0)
    ? parsed
    : null;
}

function hasWholeLineMarker(body) {
  if (typeof body !== 'string') return false;
  return body.split(/\r?\n/).map((line) => line.trimEnd()).includes(REVIEW_EVIDENCE_MARKER);
}

function commentEffectiveTime(comment) {
  // F1: issue comments can be edited after posting, so the ordering control uses
  // the later of created_at and updated_at (GitHub always returns updated_at for
  // issue comments; created_at is the fallback for recorded/mocked payloads).
  const stamp = comment.updated_at || comment.created_at;
  const value = Date.parse(stamp || '');
  return Number.isFinite(value) ? value : null;
}

function normalizeModel(value) {
  // F4: compare model declarations after stripping punctuation/whitespace so
  // "DeepSeek-V4" and "DeepSeek V4" cannot pass as different vendors.
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function trustedReviewer(review, pr) {
  return Boolean(review && review.user && review.user.login)
    && review.user.login !== (pr && pr.user ? pr.user.login : undefined)
    && review.user.type === 'User'
    && ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(review.author_association);
}

function formalMarkerMatches(body, head) {
  const match = FORMAL_REVIEW_MARKER.exec(body || '');
  return Boolean(match) && match[1] === head;
}

function createdBeforeMerge(timestamp, mergedAt) {
  const value = Date.parse(timestamp || '');
  const merged = Date.parse(mergedAt || '');
  return Number.isFinite(value) && Number.isFinite(merged) && value <= merged;
}

async function evaluateReviewEvidence(inputs, pr, head, mergedAt, fetchImpl) {
  const reviews = await paginate(inputs, 'pulls/' + inputs.reviewPr + '/reviews', fetchImpl);
  const latestByLogin = new Map();
  for (const review of reviews) {
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) continue;
    if (!review.user || !review.user.login) continue;
    latestByLogin.set(review.user.login, review);
  }
  const latest = [...latestByLogin.values()];
  requireCode(
    !latest.some((review) => review.state === 'CHANGES_REQUESTED' && trustedReviewer(review, pr)),
    'E_CHANGES_REQUESTED',
  );
  const approvalsAtHead = latest.filter((review) => review.state === 'APPROVED'
    && review.commit_id === head
    && formalMarkerMatches(review.body, head));
  const timelyApprovals = approvalsAtHead.filter((review) => createdBeforeMerge(review.submitted_at, mergedAt));
  let formalTrustDeny = null;
  for (const review of timelyApprovals) {
    if (!trustedReviewer(review, pr)) {
      if (review.user && review.user.login !== (pr.user && pr.user.login)) formalTrustDeny = 'E_REVIEW_NOT_TRUSTED';
      continue;
    }
    // The formal path keeps the pre-existing repository-permission lookup: the
    // Actions token capability is unproven, so a failed lookup denies this path
    // closed (the D-G2 agent-evidence path is the documented route meanwhile).
    let permission;
    try {
      permission = await githubGet(
        inputs,
        'collaborators/' + encodeURIComponent(review.user.login) + '/permission',
        fetchImpl,
      );
    } catch {
      formalTrustDeny = 'E_REVIEW_TRUST_UNVERIFIED';
      continue;
    }
    if (!permission || !['admin', 'maintain', 'write'].includes(permission.permission)) {
      formalTrustDeny = 'E_REVIEW_NOT_TRUSTED';
      continue;
    }
    return {
      kind: 'formal-review',
      id: review.id,
      login: review.user.login,
      submittedAt: review.submitted_at,
    };
  }

  const comments = await paginate(inputs, 'issues/' + inputs.reviewPr + '/comments', fetchImpl);
  // F3: this repository is public, so ANY GitHub user can comment. Only a
  // whole-line marker comment from the repository owner account (a User, not a
  // Bot/Organization) is review evidence. The filter runs BEFORE choosing the
  // latest comment, so an outsider comment cannot block or supersede a deploy.
  const ownerEvidenceComments = comments.filter((comment) => typeof comment.body === 'string'
    && hasWholeLineMarker(comment.body)
    && comment.author_association === 'OWNER'
    && comment.user && comment.user.type === 'User');
  // F1/R1: comments can be edited after they are posted, so the ordering control
  // uses the LAST edit (updated_at, falling back to created_at). An evidence
  // comment is eligible only if that time is <= merged_at. R1: if ANY owner
  // whole-line-marker comment was edited after the merge (or has an unparseable
  // timestamp), deny E_REVIEW_ORDER unconditionally - otherwise a post-merge edit
  // of a REVISE block would make it ineligible and resurrect an older PASS block.
  const mergedTime = Date.parse(mergedAt || '');
  const eligibleEvidence = [];
  let orderDeny = false;
  for (const comment of ownerEvidenceComments) {
    const effective = commentEffectiveTime(comment);
    if (effective === null || !Number.isFinite(mergedTime) || effective > mergedTime) {
      orderDeny = true;
      continue;
    }
    eligibleEvidence.push({ comment, effective });
  }
  eligibleEvidence.sort((left, right) => left.effective - right.effective
    || Number(left.comment.id || 0) - Number(right.comment.id || 0));
  let evidenceDeny = null;
  let evidenceAllow = null;
  if (eligibleEvidence.length > 0) {
    const comment = eligibleEvidence[eligibleEvidence.length - 1].comment;
    const parsed = parseEvidenceBlock(comment.body);
    if (!parsed) evidenceDeny = 'E_REVIEW_MARKER';
    else if (parsed.verdict !== 'PASS') evidenceDeny = 'E_REVIEW_REVISE';
    else if (!HEX40.test(parsed.reviewedHead) || parsed.reviewedHead !== head) evidenceDeny = 'E_REVIEW_MARKER';
    else if (!HEX64.test(parsed.reviewedBodySha256)) evidenceDeny = 'E_REVIEW_MARKER';
    else if (parsed.reviewedBodySha256 !== sha256(pr.body || '')) evidenceDeny = 'E_REVIEW_BODY';
    else if (!EVIDENCE_MODEL.test(parsed.reviewerModel) || !EVIDENCE_MODEL.test(parsed.builderModel)) evidenceDeny = 'E_REVIEW_MARKER';
    else if (normalizeModel(parsed.reviewerModel) === normalizeModel(parsed.builderModel)) evidenceDeny = 'E_REVIEW_INDEPENDENCE';
    else {
      evidenceAllow = {
        kind: 'agent-evidence-comment',
        id: comment.id,
        login: comment.user.login,
        createdAt: comment.created_at,
        updatedAt: comment.updated_at || comment.created_at,
        reviewerModel: parsed.reviewerModel,
        builderModel: parsed.builderModel,
      };
    }
  }

  // R1: this check is unconditional, before any eligible evidence may allow.
  requireCode(!orderDeny, 'E_REVIEW_ORDER');
  if (evidenceAllow) return evidenceAllow;
  requireCode(!approvalsAtHead.some((review) => review.user && review.user.login === (pr.user && pr.user.login)), 'E_REVIEW_SELF');
  requireCode(!formalTrustDeny, formalTrustDeny);
  requireCode(approvalsAtHead.length === 0, 'E_REVIEW_ORDER');
  if (evidenceDeny) throw new GateError(evidenceDeny);
  throw new GateError('E_REVIEW_NONE');
}

async function evaluateCi(inputs, head, fetchImpl) {
  const runs = await githubGet(
    inputs,
    'actions/workflows/ci.yml/runs?head_sha=' + head + '&event=push&per_page=100',
    fetchImpl,
  );
  requireCode(runs && Array.isArray(runs.workflow_runs), 'E_CI_MISSING');
  const run = runs.workflow_runs[0];
  requireCode(Boolean(run), 'E_CI_MISSING');
  requireCode(run.head_sha === head, 'E_CI_HEAD_MISMATCH');
  requireCode(run.event === 'push' && run.status === 'completed' && run.conclusion === 'success', 'E_CI_NOT_GREEN');
  return { id: run.id, conclusion: run.conclusion, headSha: run.head_sha };
}

export async function evaluateGate(options) {
  const config = options || {};
  const inputs = parseInputs(config.env || process.env);
  const fetchImpl = config.fetchImpl || globalThis.fetch;
  const git = config.git || createGit();

  let checkedOutSha;
  try {
    checkedOutSha = git(['rev-parse', 'HEAD']);
  } catch {
    throw new GateError('E_GIT_UNAVAILABLE');
  }
  requireCode(checkedOutSha === inputs.dispatchSha, 'E_GIT_DISPATCH_MISMATCH');

  let tracked;
  let treeOfDispatch;
  try {
    tracked = git(['ls-tree', '-r', '--name-only', inputs.dispatchSha]).split('\n').filter(Boolean);
    treeOfDispatch = git(['rev-parse', inputs.dispatchSha + '^{tree}']);
  } catch {
    throw new GateError('E_GIT_UNAVAILABLE');
  }
  for (const artifact of REQUIRED_ARTIFACTS) {
    requireCode(tracked.includes(artifact), 'E_REQUIRED_ARTIFACTS');
  }

  const pr = await githubGet(inputs, 'pulls/' + inputs.reviewPr, fetchImpl);
  requireCode(Boolean(pr), 'E_PR_NOT_FOUND');
  requireCode(pr.state === 'closed' && pr.merged === true && Boolean(pr.merged_at), 'E_PR_NOT_MERGED');
  requireCode(pr.base && pr.base.ref === 'main', 'E_PR_BASE_BRANCH');
  requireCode(pr.base && pr.base.repo && pr.base.repo.full_name === inputs.repository, 'E_PR_BASE_REPO');
  const head = pr.head && pr.head.sha;
  requireCode(HEX40.test(head || '') && Boolean(pr.head && pr.head.repo) && pr.head.repo.full_name === inputs.repository, 'E_PR_HEAD_IDENTITY');
  requireCode(pr.merge_commit_sha === inputs.dispatchSha, 'E_MERGE_COMMIT_MISMATCH');

  const mergeCommit = await githubGet(inputs, 'git/commits/' + inputs.dispatchSha, fetchImpl);
  const parents = mergeCommit && mergeCommit.parents;
  requireCode(Array.isArray(parents) && parents.length === 2, 'E_PARENT_COUNT');
  requireCode(parents[1] && parents[1].sha === head, 'E_SECOND_PARENT_MISMATCH');
  requireCode(mergeCommit && mergeCommit.tree && mergeCommit.tree.sha === treeOfDispatch, 'E_MERGE_COMMIT_MISMATCH');

  let treeOfHead;
  try {
    treeOfHead = git(['rev-parse', head + '^{tree}']);
  } catch {
    throw new GateError('E_GIT_UNAVAILABLE');
  }
  requireCode(treeOfHead === treeOfDispatch, 'E_STRICT_TREE_MISMATCH');

  const review = await evaluateReviewEvidence(inputs, pr, head, pr.merged_at, fetchImpl);
  const ci = await evaluateCi(inputs, head, fetchImpl);

  return {
    decision: 'ALLOW',
    code: 'GATE_OK',
    evidence: {
      repository: inputs.repository,
      reviewPr: Number(inputs.reviewPr),
      reviewedHead: head,
      mergeCommit: inputs.dispatchSha,
      tree: treeOfDispatch,
      secondParent: parents[1].sha,
      ref: inputs.ref,
      review: review.kind,
      reviewId: review.id,
      reviewer: review.login,
      ciRunId: ci.id,
      ciConclusion: ci.conclusion,
    },
  };
}

export function formatAllow(result) {
  const ev = result.evidence;
  return [
    'GATE OK',
    'code=' + result.code,
    'pr=' + ev.reviewPr,
    'reviewed-head=' + ev.reviewedHead,
    'merge-commit=' + ev.mergeCommit,
    'tree=' + ev.tree,
    'review=' + ev.review + ':' + ev.reviewId,
    'reviewer=' + String(ev.reviewer).replace(/[^A-Za-z0-9._-]/g, '_'),
    'ci-run=' + ev.ciRunId,
    'ref=' + ev.ref,
  ].join(' ');
}

export function formatDeny(code) {
  return 'Deployment gate denied: ' + (REASON_CODES[code] ? code : 'E_INTERNAL');
}

async function main() {
  try {
    const result = await evaluateGate();
    console.log(formatAllow(result));
  } catch (error) {
    const code = error instanceof GateError ? error.code : 'E_INTERNAL';
    console.error(formatDeny(code));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
