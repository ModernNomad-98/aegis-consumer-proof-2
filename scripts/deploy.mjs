const { RENDER_DEPLOY_HOOK_URL, HEALTHCHECK_URL, GITHUB_SHA } = process.env;
// Documented default: render.yaml defines a Render web service named
// "tenant-workspace", whose public origin is https://tenant-workspace.onrender.com
// and whose health path is /health. If the service is created under another name,
// set the HEALTHCHECK_URL repository/environment variable; it always wins.
const DEFAULT_SERVICE_ORIGIN = 'https://tenant-workspace.onrender.com';
function healthEndpoint() {
  const configured = (HEALTHCHECK_URL ?? '').trim();
  const health = new URL(configured === '' ? `${DEFAULT_SERVICE_ORIGIN}/health` : configured);
  if (health.protocol !== 'https:' || health.pathname !== '/health') throw new Error('Invalid health endpoint');
  return health;
}
try {
  if (!/^[a-f0-9]{40}$/.test(GITHUB_SHA ?? '')) throw new Error('Exact revision required');
  const hook = new URL(RENDER_DEPLOY_HOOK_URL ?? '');
  const health = healthEndpoint();
  if (hook.protocol !== 'https:' || hook.hostname !== 'api.render.com') throw new Error('Invalid endpoint');
  hook.searchParams.set('ref', GITHUB_SHA);
  const response = await fetch(hook, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error('Deploy request rejected');
  // Never print the hook, response payload or exception: they may contain secrets.
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const check = await fetch(health, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
      const body = await check.json();
      if (check.ok && body.status === 'ok' && body.revision === GITHUB_SHA) {
        console.log('Health smoke passed for exact deployed revision'); process.exit(0);
      }
    } catch { /* A deployment may temporarily be unavailable. */ }
    await new Promise(resolve => setTimeout(resolve, 10000));
  }
  throw new Error('Health timeout');
} catch { console.error('Deployment or exact-revision health smoke failed; inspect the service privately'); process.exitCode = 1; }
