import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  evaluateGate,
  createGit,
  formatAllow,
  formatDeny,
  GateError,
  REASON_CODES,
} from '../scripts/review-gate.mjs';

const ORIGIN = { full_name: 'o/r' };
const BASE_ENV = {
  GITHUB_TOKEN: 'test-token-not-real',
  GITHUB_REPOSITORY: 'o/r',
  GITHUB_REF: 'refs/heads/main',
  REVIEW_PR: '1',
};
const MERGED_AT = '2026-10-30T21:00:00Z';
const PR_BODY = 'candidate pull request body\n';
const FIXTURE_ROOT = process.env.AEGIS_REVIEW_GATE_TMP
  || path.join(process.cwd(), 'test-results', 'gate-fixtures');
mkdirSync(FIXTURE_ROOT, { recursive: true });

function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'Gate Test',
    GIT_AUTHOR_EMAIL: 'gate@example.invalid',
    GIT_COMMITTER_NAME: 'Gate Test',
    GIT_COMMITTER_EMAIL: 'gate@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function gitIn(directory, args) {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: gitEnv(),
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

function writeFile(directory, relative, content) {
  const target = path.join(directory, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content, 'utf8');
}

function commitAll(directory, message) {
  gitIn(directory, ['add', '-A']);
  gitIn(directory, ['commit', '-q', '-m', message]);
  return gitIn(directory, ['rev-parse', 'HEAD']);
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function baseFiles(directory) {
  writeFile(directory, 'package-lock.json', '{"lockfileVersion":3}\n');
  writeFile(directory, '.github/workflows/ci.yml', 'name: Verify\n');
  writeFile(directory, 'scripts/reproduce.mjs', '// reproduce runner\n');
  writeFile(directory, 'scripts/review-gate.mjs', '// review gate\n');
  writeFile(directory, 'README.md', '# base\n');
}

function makeFixture(options) {
  const opts = options || {};
  const directory = mkdtempSync(path.join(FIXTURE_ROOT, 'case-'));
  gitIn(directory, ['init', '-q', '-b', 'main']);
  baseFiles(directory);
  const base = commitAll(directory, 'base');
  gitIn(directory, ['checkout', '-q', '-b', 'feature']);
  writeFile(directory, 'src/app.ts', 'export const value = 1;\n');
  writeFile(directory, 'docs/implementation-report.md', '# report\n');
  const head = commitAll(directory, 'feature');
  gitIn(directory, ['checkout', '-q', 'main']);
  if (opts.advanceMain) {
    writeFile(directory, '.github/workflows/connectivity.yml', 'name: connectivity\n');
    commitAll(directory, 'advance main');
  }
  gitIn(directory, ['merge', '--no-ff', '-q', '-m', 'merge feature', 'feature']);
  const merge = gitIn(directory, ['rev-parse', 'HEAD']);
  if (opts.afterMergeCommit) {
    writeFile(directory, 'after-merge.txt', 'post-merge main advance\n');
    commitAll(directory, 'after merge');
  }
  if (opts.checkout) gitIn(directory, ['checkout', '-q', opts.checkout]);
  return { directory, base, head, merge };
}

function cleanup(fixture) {
  rmSync(fixture.directory, { recursive: true, force: true });
}

function fixtureTree(fixture, revision) {
  return gitIn(fixture.directory, ['rev-parse', revision + '^{tree}']);
}

function context(fixture, overrides) {
  const opts = overrides || {};
  const pr = {
    number: 1,
    state: 'closed',
    merged: true,
    merged_at: MERGED_AT,
    base: { ref: 'main', repo: ORIGIN },
    head: { sha: fixture.head, repo: ORIGIN, ref: 'feature' },
    merge_commit_sha: fixture.merge,
    user: { login: 'owner' },
    body: PR_BODY,
  };
  const commit = {
    sha: fixture.merge,
    tree: { sha: fixtureTree(fixture, fixture.merge) },
    parents: [{ sha: fixture.base }, { sha: fixture.head }],
  };
  return {
    pr: Object.assign(pr, opts.pr || {}),
    commit: Object.assign(commit, opts.commit || {}),
    reviews: opts.reviews || [],
    comments: opts.comments || [],
    runs: opts.runs || {
      workflow_runs: [{ id: 99, head_sha: fixture.head, event: 'push', status: 'completed', conclusion: 'success' }],
    },
    prStatus: opts.prStatus || 200,
    commitStatus: opts.commitStatus || 200,
    reviewsStatus: opts.reviewsStatus || 200,
    commentsStatus: opts.commentsStatus || 200,
    runsStatus: opts.runsStatus || 200,
    permissionStatus: opts.permissionStatus || 200,
    permission: opts.permission || 'write',
    loopPagination: Boolean(opts.loopPagination),
  };
}

function pageOf(items, page) {
  if (page === 1) return items.slice(0, 100);
  return items.slice(100);
}

function responseFor(status, payload) {
  if (status >= 400) return { ok: false, status, json: async () => ({}) };
  return { ok: true, status, json: async () => payload };
}

function fakeFetch(ctx) {
  return async (url) => {
    const parsed = new URL(url);
    const route = parsed.pathname.replace('/repos/o/r/', '');
    const page = Number(parsed.searchParams.get('page') || '1');
    if (ctx.loopPagination && route.endsWith('/reviews')) {
      return responseFor(200, new Array(100).fill({ state: 'COMMENTED', user: { login: 'loop' } }));
    }
    if (route === 'pulls/1') return responseFor(ctx.prStatus, ctx.pr);
    if (route === 'git/commits/' + ctx.commit.sha) return responseFor(ctx.commitStatus, ctx.commit);
    if (route === 'pulls/1/reviews') return responseFor(ctx.reviewsStatus, pageOf(ctx.reviews, page));
    if (route === 'issues/1/comments') return responseFor(ctx.commentsStatus, pageOf(ctx.comments, page));
    if (route === 'actions/workflows/ci.yml/runs') return responseFor(ctx.runsStatus, ctx.runs);
    if (route.startsWith('collaborators/') && route.endsWith('/permission')) {
      return responseFor(ctx.permissionStatus, { permission: ctx.permission });
    }
    return responseFor(404, {});
  };
}

function evidenceComment(overrides) {
  const opts = overrides || {};
  const created = opts.created_at || '2026-10-30T20:30:00Z';
  const fields = {
    verdict: opts.verdict || 'PASS',
    head: opts.head || opts.expectedHead,
    bodySha256: opts.bodySha256 || sha256(PR_BODY),
    reviewerModel: opts.reviewerModel || 'DeepSeek V4 Flash',
    builderModel: opts.builderModel || 'Claude Opus 4.6',
  };
  const lines = [
    'Aegis deploy review evidence v1',
    'verdict: ' + fields.verdict,
    'reviewed-head: ' + fields.head,
    'reviewed-body-sha256: ' + fields.bodySha256,
    'reviewer-model: ' + fields.reviewerModel,
    'builder-model: ' + fields.builderModel,
  ];
  return {
    id: opts.id || 501,
    created_at: created,
    updated_at: opts.updated_at || created,
    author_association: opts.author_association || 'OWNER',
    user: { login: opts.login || 'owner', type: opts.userType || 'User' },
    body: opts.body || lines.join('\n'),
  };
}

function formalReview(fixture, overrides) {
  const opts = overrides || {};
  return {
    id: opts.id || 701,
    state: opts.state || 'APPROVED',
    commit_id: opts.commit_id || fixture.head,
    submitted_at: opts.submitted_at || '2026-10-30T20:40:00Z',
    author_association: opts.author_association || 'MEMBER',
    user: { login: opts.login || 'reviewer-account', type: 'User' },
    body: opts.body || ('SD-F review PASS\nReproduce reviewed: ' + fixture.head + '\n'),
  };
}

function envFor(fixture, overrides) {
  return Object.assign({
    GITHUB_TOKEN: BASE_ENV.GITHUB_TOKEN,
    GITHUB_REPOSITORY: BASE_ENV.GITHUB_REPOSITORY,
    GITHUB_REF: BASE_ENV.GITHUB_REF,
    REVIEW_PR: BASE_ENV.REVIEW_PR,
    GITHUB_SHA: fixture.merge,
  }, overrides || {});
}

function runGate(fixture, ctx, envOverrides) {
  return evaluateGate({
    env: envFor(fixture, envOverrides),
    fetchImpl: fakeFetch(ctx),
    git: createGit(fixture.directory),
  });
}

async function expectDeny(fixture, ctx, code, envOverrides) {
  await assert.rejects(
    runGate(fixture, ctx, envOverrides),
    (error) => error instanceof GateError && error.code === code,
    'expected deny ' + code,
  );
}

test('positive: strict merge mapping, agent review evidence and exact-head CI allow', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, { comments: [evidenceComment({ expectedHead: fixture.head })] });
  const result = await runGate(fixture, ctx);
  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.code, 'GATE_OK');
  assert.equal(result.evidence.reviewedHead, fixture.head);
  assert.equal(result.evidence.mergeCommit, fixture.merge);
  assert.equal(result.evidence.review, 'agent-evidence-comment');
  assert.equal(result.evidence.tree, fixtureTree(fixture, fixture.merge));
  const line = formatAllow(result);
  assert.match(line, /^GATE OK /);
  assert.ok(!line.includes('test-token-not-real'));
});

test('positive: formal distinct-account approval at the reviewed head allows', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, { reviews: [formalReview(fixture)] });
  const result = await runGate(fixture, ctx);
  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.evidence.review, 'formal-review');
});

test('positive: decision history and paginated evidence are handled', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const reviews = new Array(100).fill(null).map((_, index) => ({
    id: index + 1,
    state: 'COMMENTED',
    commit_id: fixture.head,
    submitted_at: '2026-10-30T20:10:00Z',
    user: { login: 'commenter-' + index, type: 'User' },
    author_association: 'MEMBER',
    body: '',
  }));
  reviews.push(formalReview(fixture, { id: 1500 }));
  const ctx = context(fixture, { reviews });
  const result = await runGate(fixture, ctx);
  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.evidence.reviewId, 1500);
});

test('positive: latest evidence comment wins over an earlier PASS', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const first = evidenceComment({ expectedHead: fixture.head, id: 1, created_at: '2026-10-30T20:01:00Z', reviewerModel: 'Model A' });
  const second = Object.assign(evidenceComment({
    expectedHead: fixture.head,
    id: 2,
    created_at: '2026-10-30T20:02:00Z',
    reviewerModel: 'Model B',
  }));
  const result = await runGate(fixture, context(fixture, { comments: [first, second] }));
  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.evidence.reviewId, 2);
});

test('positive: post-merge main advances do not invalidate the immutable mapping', async (t) => {
  const fixture = makeFixture({ afterMergeCommit: true });
  t.after(() => cleanup(fixture));
  gitIn(fixture.directory, ['checkout', '-q', fixture.merge]);
  const ctx = context(fixture, { comments: [evidenceComment({ expectedHead: fixture.head })] });
  const result = await runGate(fixture, ctx);
  assert.equal(result.decision, 'ALLOW');
});

test('positive: merged PR branch deletion (null head ref) still allows', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    pr: { head: { sha: fixture.head, repo: ORIGIN, ref: null }, body: PR_BODY },
    comments: [evidenceComment({ expectedHead: fixture.head })],
  });
  const result = await runGate(fixture, ctx);
  assert.equal(result.decision, 'ALLOW');
});

test('negative: one-parent squash merge shape is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, { commit: { parents: [{ sha: fixture.base }] } });
  await expectDeny(fixture, ctx, 'E_PARENT_COUNT');
});

test('negative: octopus merge shape is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    commit: { parents: [{ sha: fixture.base }, { sha: fixture.head }, { sha: fixture.base }] },
  });
  await expectDeny(fixture, ctx, 'E_PARENT_COUNT');
});

test('negative: second parent different from the reviewed head is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, { commit: { parents: [{ sha: fixture.base }, { sha: fixture.base }] } });
  await expectDeny(fixture, ctx, 'E_SECOND_PARENT_MISMATCH');
});

test('negative: unmerged pull request is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  await expectDeny(fixture, context(fixture, { pr: { merged: false, merged_at: null } }), 'E_PR_NOT_MERGED');
});

test('negative: merge_commit_sha mismatch is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  await expectDeny(fixture, context(fixture, { pr: { merge_commit_sha: fixture.head } }), 'E_MERGE_COMMIT_MISMATCH');
});

test('negative: non-main base branch is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  await expectDeny(fixture, context(fixture, { pr: { base: { ref: 'release', repo: ORIGIN } } }), 'E_PR_BASE_BRANCH');
});

test('negative: fork base repository is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  await expectDeny(fixture, context(fixture, {
    pr: { base: { ref: 'main', repo: { full_name: 'fork/r' } } },
  }), 'E_PR_BASE_REPO');
});

test('negative: fork head repository is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  await expectDeny(fixture, context(fixture, {
    pr: { head: { sha: fixture.head, repo: { full_name: 'fork/r' } } },
  }), 'E_PR_HEAD_IDENTITY');
});

test('negative: non-main dispatch ref is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  await expectDeny(fixture, context(fixture), 'E_REF_NOT_MAIN', { GITHUB_REF: 'refs/heads/feature' });
});

test('negative: malformed environment input is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  await expectDeny(fixture, context(fixture), 'E_ENV_INPUT', { GITHUB_TOKEN: '' });
  await expectDeny(fixture, context(fixture), 'E_ENV_INPUT', { GITHUB_SHA: 'not-a-sha' });
  await expectDeny(fixture, context(fixture), 'E_ENV_INPUT', { REVIEW_PR: 'one' });
});

test('negative: missing required committed artifact is denied', async (t) => {
  const directory = mkdtempSync(path.join(FIXTURE_ROOT, 'case-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  gitIn(directory, ['init', '-q', '-b', 'main']);
  writeFile(directory, 'package-lock.json', '{}\n');
  writeFile(directory, '.github/workflows/ci.yml', 'name: Verify\n');
  writeFile(directory, 'README.md', '# no runner\n');
  const base = commitAll(directory, 'base');
  gitIn(directory, ['checkout', '-q', '-b', 'feature']);
  writeFile(directory, 'src/app.ts', 'export const value = 1;\n');
  const head = commitAll(directory, 'feature');
  gitIn(directory, ['checkout', '-q', 'main']);
  gitIn(directory, ['merge', '--no-ff', '-q', '-m', 'merge feature', 'feature']);
  const merge = gitIn(directory, ['rev-parse', 'HEAD']);
  const fixture = { directory, base, head, merge };
  const ctx = context(fixture, { comments: [evidenceComment({ expectedHead: head })] });
  await expectDeny(fixture, ctx, 'E_REQUIRED_ARTIFACTS');
});

test('negative: main-side divergence breaks strict tree equality', async (t) => {
  const fixture = makeFixture({ advanceMain: true });
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, { comments: [evidenceComment({ expectedHead: fixture.head })] });
  await expectDeny(fixture, ctx, 'E_STRICT_TREE_MISMATCH');
});

test('negative: checked-out revision different from dispatch is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  gitIn(fixture.directory, ['checkout', '-q', fixture.head]);
  await expectDeny(fixture, context(fixture), 'E_GIT_DISPATCH_MISMATCH');
});

test('negative: absent review evidence is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  await expectDeny(fixture, context(fixture), 'E_REVIEW_NONE');
});

test('negative: agent review evidence bound to another head is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    comments: [evidenceComment({ expectedHead: fixture.base })],
  });
  await expectDeny(fixture, ctx, 'E_REVIEW_MARKER');
});

test('negative: stale reviewed body hash is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    comments: [evidenceComment({ expectedHead: fixture.head, bodySha256: sha256('stale body') })],
  });
  await expectDeny(fixture, ctx, 'E_REVIEW_BODY');
});

test('negative: same-vendor reviewer and builder models are denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    comments: [evidenceComment({ expectedHead: fixture.head, reviewerModel: 'DeepSeek V4 Flash', builderModel: 'DeepSeek V4 Flash' })],
  });
  await expectDeny(fixture, ctx, 'E_REVIEW_INDEPENDENCE');
});

test('negative: latest agent review evidence with REVISE verdict is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const pass = evidenceComment({ expectedHead: fixture.head, id: 1, created_at: '2026-10-30T20:01:00Z' });
  const revise = evidenceComment({ expectedHead: fixture.head, id: 2, created_at: '2026-10-30T20:02:00Z', verdict: 'REVISE' });
  await expectDeny(fixture, context(fixture, { comments: [pass, revise] }), 'E_REVIEW_REVISE');
});

test('negative: malformed evidence block is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const malformed = evidenceComment({ expectedHead: fixture.head });
  malformed.body = 'Aegis deploy review evidence v1\nverdict: PASS\nreviewed-head: ' + fixture.head + '\n';
  await expectDeny(fixture, context(fixture, { comments: [malformed] }), 'E_REVIEW_MARKER');
});

test('positive: evidence created and last edited before the merge allows (F1)', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    comments: [evidenceComment({
      expectedHead: fixture.head,
      created_at: '2026-10-30T20:10:00Z',
      updated_at: '2026-10-30T20:55:00Z',
    })],
  });
  const result = await runGate(fixture, ctx);
  assert.equal(result.decision, 'ALLOW');
});

test('negative: an evidence comment edited after the merge is denied (F1)', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  // created before the 21:00Z merge, rewritten into a PASS block afterwards
  const ctx = context(fixture, {
    comments: [evidenceComment({
      expectedHead: fixture.head,
      created_at: '2026-10-30T20:10:00Z',
      updated_at: '2026-10-30T22:30:00Z',
    })],
  });
  await expectDeny(fixture, ctx, 'E_REVIEW_ORDER');
});

test('negative: an owner marker comment edited post-merge cannot be downgraded to REVISE (F1)', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const rewrittenAfterMerge = evidenceComment({
    expectedHead: fixture.head,
    id: 1,
    created_at: '2026-10-30T20:10:00Z',
    updated_at: '2026-10-30T22:30:00Z',
    verdict: 'PASS',
  });
  await expectDeny(fixture, context(fixture, { comments: [rewrittenAfterMerge] }), 'E_REVIEW_ORDER');
});

test('negative: non-owner marker comments are ignored, not treated as denial (F3)', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    comments: [evidenceComment({ expectedHead: fixture.head, author_association: 'CONTRIBUTOR' })],
  });
  await expectDeny(fixture, ctx, 'E_REVIEW_NONE');
});

test('positive: a later outsider marker comment cannot block valid owner evidence (F3)', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ownerEvidence = evidenceComment({
    expectedHead: fixture.head,
    id: 1,
    created_at: '2026-10-30T20:10:00Z',
    updated_at: '2026-10-30T20:10:00Z',
  });
  const outsiderNoise = evidenceComment({
    expectedHead: fixture.head,
    id: 2,
    created_at: '2026-10-30T20:50:00Z',
    updated_at: '2026-10-30T20:50:00Z',
    author_association: 'CONTRIBUTOR',
    verdict: 'REVISE',
  });
  const result = await runGate(fixture, context(fixture, { comments: [ownerEvidence, outsiderNoise] }));
  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.evidence.reviewId, 1);
});

test('negative: owner evidence from a bot account is not treated as owner evidence (F3)', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    comments: [evidenceComment({ expectedHead: fixture.head, userType: 'Bot' })],
  });
  await expectDeny(fixture, ctx, 'E_REVIEW_NONE');
});

test('negative: the evidence marker must be an exact whole line (F3)', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const malformed = evidenceComment({ expectedHead: fixture.head });
  malformed.body = 'see Aegis deploy review evidence v1 above\n'
    + 'verdict: PASS\n'
    + 'reviewed-head: ' + fixture.head + '\n'
    + 'reviewed-body-sha256: ' + sha256(PR_BODY) + '\n'
    + 'reviewer-model: DeepSeek V4 Flash\n'
    + 'builder-model: Claude Opus 4.6\n';
  await expectDeny(fixture, context(fixture, { comments: [malformed] }), 'E_REVIEW_NONE');
});

test('negative: model declarations equal after punctuation normalization are denied (F4)', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    comments: [evidenceComment({
      expectedHead: fixture.head,
      reviewerModel: 'DeepSeek-V4',
      builderModel: 'DeepSeek V4',
    })],
  });
  await expectDeny(fixture, ctx, 'E_REVIEW_INDEPENDENCE');
});

test('negative: review evidence that postdates the merge is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    comments: [evidenceComment({ expectedHead: fixture.head, created_at: '2026-10-30T22:00:00Z' })],
  });
  await expectDeny(fixture, ctx, 'E_REVIEW_ORDER');
});

test('negative: self-authored approval at the head is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    reviews: [formalReview(fixture, { login: 'owner' })],
    pr: { user: { login: 'owner' } },
  });
  await expectDeny(fixture, ctx, 'E_REVIEW_SELF');
});

test('negative: unresolved trusted change request is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    reviews: [
      formalReview(fixture, { state: 'CHANGES_REQUESTED', login: 'blocking-reviewer' }),
      formalReview(fixture, { id: 702 }),
    ],
  });
  await expectDeny(fixture, ctx, 'E_CHANGES_REQUESTED');
});

test('negative: trusted approval bound to an older head is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    reviews: [formalReview(fixture, { commit_id: fixture.base, body: 'Reproduce reviewed: ' + fixture.base + '\n' })],
    comments: [evidenceComment({ expectedHead: fixture.head })],
  });
  const result = await runGate(fixture, ctx);
  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.evidence.review, 'agent-evidence-comment');
});

test('negative: missing exact-head CI run is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    comments: [evidenceComment({ expectedHead: fixture.head })],
    runs: { workflow_runs: [] },
  });
  await expectDeny(fixture, ctx, 'E_CI_MISSING');
});

test('negative: exact-head CI run with wrong head is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    comments: [evidenceComment({ expectedHead: fixture.head })],
    runs: { workflow_runs: [{ id: 99, head_sha: fixture.base, event: 'push', status: 'completed', conclusion: 'success' }] },
  });
  await expectDeny(fixture, ctx, 'E_CI_HEAD_MISMATCH');
});

test('negative: red exact-head CI run is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, {
    comments: [evidenceComment({ expectedHead: fixture.head })],
    runs: { workflow_runs: [{ id: 99, head_sha: fixture.head, event: 'push', status: 'completed', conclusion: 'failure' }] },
  });
  await expectDeny(fixture, ctx, 'E_CI_NOT_GREEN');
});

test('negative: formal review from a read-only collaborator is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, { reviews: [formalReview(fixture)], permission: 'read' });
  await expectDeny(fixture, ctx, 'E_REVIEW_NOT_TRUSTED');
});

test('negative: unverifiable collaborator permission denies the formal path', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, { reviews: [formalReview(fixture)], permissionStatus: 403 });
  await expectDeny(fixture, ctx, 'E_REVIEW_TRUST_UNVERIFIED');
});

test('negative: missing pull request is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  await expectDeny(fixture, context(fixture, { prStatus: 404 }), 'E_PR_NOT_FOUND');
});

test('negative: GitHub API failure is denied as an evidence lookup failure', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  await expectDeny(fixture, context(fixture, { commentsStatus: 500 }), 'E_EVIDENCE_LOOKUP');
});

test('negative: unbounded review pagination is denied', async (t) => {
  const fixture = makeFixture();
  t.after(() => cleanup(fixture));
  const ctx = context(fixture, { loopPagination: true });
  await expectDeny(fixture, ctx, 'E_REVIEW_PAGINATION');
});

test('closed vocabulary and output contract', () => {
  for (const code of Object.keys(REASON_CODES)) {
    assert.equal(typeof REASON_CODES[code], 'string');
  }
  assert.equal(formatDeny('E_STRICT_TREE_MISMATCH'), 'Deployment gate denied: E_STRICT_TREE_MISMATCH');
  assert.equal(formatDeny('NOT_A_CODE'), 'Deployment gate denied: E_INTERNAL');
  const allowed = formatAllow({
    decision: 'ALLOW',
    code: 'GATE_OK',
    evidence: {
      repository: 'o/r',
      reviewPr: 3,
      reviewedHead: 'a'.repeat(40),
      mergeCommit: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      secondParent: 'a'.repeat(40),
      ref: 'refs/heads/main',
      review: 'agent-evidence-comment',
      reviewId: 12,
      reviewer: 'owner',
      ciRunId: 34,
      ciConclusion: 'success',
    },
  });
  assert.match(allowed, /^GATE OK code=GATE_OK pr=3 /);
  assert.ok(!allowed.includes('Bearer'));
});
