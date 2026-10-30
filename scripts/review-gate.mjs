import { execFileSync } from 'node:child_process';
const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_SHA, REVIEW_PR } = process.env;
async function get(path) {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/${path}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('Review evidence unavailable');
  return response.json();
}
try {
  if (!GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPOSITORY ?? '') || !/^[a-f0-9]{40}$/.test(GITHUB_SHA ?? '') || !/^\d+$/.test(REVIEW_PR ?? '')) throw new Error('Missing gate input');
  const tracked = execFileSync('git', ['ls-tree', '-r', '--name-only', GITHUB_SHA], { encoding: 'utf8' }).split('\n');
  for (const file of ['scripts/reproduce.mjs','package-lock.json','.github/workflows/ci.yml']) if (!tracked.includes(file)) throw new Error('Required reproduce artifact is not committed');
  const pr = await get(`pulls/${REVIEW_PR}`);
  if (pr.head.sha !== GITHUB_SHA || pr.head.repo.full_name !== GITHUB_REPOSITORY) throw new Error('Review is not for this exact repository head');
  const latest = new Map();
  for (let page = 1; ; page++) {
    const reviews = await get(`pulls/${REVIEW_PR}/reviews?per_page=100&page=${page}`);
    for (const review of reviews) if (['APPROVED','CHANGES_REQUESTED','DISMISSED'].includes(review.state)) latest.set(review.user.login, review);
    if (reviews.length < 100) break;
  }
  const trusted = [];
  for (const review of latest.values()) {
    if (review.user.login === pr.user.login || review.user.type !== 'User') continue;
    const permission = await get(`collaborators/${encodeURIComponent(review.user.login)}/permission`);
    if (['admin','maintain','write'].includes(permission.permission)) trusted.push(review);
  }
  if (trusted.some(review => review.state === 'CHANGES_REQUESTED')) throw new Error('Unresolved change request');
  const approved = trusted.some(review => review.state === 'APPROVED' && review.commit_id === GITHUB_SHA && review.body?.includes(`Reproduce reviewed: ${GITHUB_SHA}`));
  if (!approved) throw new Error('Independent exact-head reproduce review required');
  const runs = await get(`actions/workflows/ci.yml/runs?head_sha=${GITHUB_SHA}&event=push&per_page=100`);
  const run = runs.workflow_runs[0];
  if (!run || run.head_sha !== GITHUB_SHA || run.status !== 'completed' || run.conclusion !== 'success') throw new Error('Latest exact-head reproduce workflow is not green');
  console.log('Independent exact-head review and committed green reproduce runner verified');
} catch { console.error('Deployment gate denied: committed runner, green CI and independent exact-head approval must all be verified'); process.exitCode = 1; }
