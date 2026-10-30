const el = id => document.getElementById(id);
async function api(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function message(text) { el('status').textContent = text; }
async function refresh() {
  const user = await api('me');
  el('signin').hidden = true; el('workspace').hidden = false;
  el('identity').textContent = `${user.tenant_id} · ${user.role}`;
  el('create').hidden = user.role !== 'admin'; el('reports').hidden = !user.reports;
  const records = await api('records');
  el('records').replaceChildren(...records.map(record => { const item = document.createElement('li'); item.textContent = record.title; return item; }));
  if (!records.length) { const item = document.createElement('li'); item.textContent = 'No records yet.'; el('records').append(item); }
  message('Workspace ready.');
}
el('login').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  try { await api('login', Object.fromEntries(new FormData(form))); form.reset(); await refresh(); } catch (error) { message(error.message); }
});
el('create').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  try { await api('records', Object.fromEntries(new FormData(form))); form.reset(); await refresh(); } catch (error) { message(error.message); }
});
el('logout').addEventListener('click', async () => {
  try { await api('logout', {}); el('workspace').hidden = true; el('signin').hidden = false; el('records').replaceChildren(); el('report-result').textContent = ''; message('Signed out.'); } catch (error) { message(error.message); }
});
el('load-report').addEventListener('click', async () => {
  try { const report = await api('reports'); el('report-result').textContent = `${report.records} records in this tenant.`; } catch (error) { message(error.message); }
});
refresh().catch(() => message('Sign in to continue.'));
