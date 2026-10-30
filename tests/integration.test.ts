import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool, context } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { tokenHash } from '../src/password.js';

test('real authentication, role, flag and cross-tenant boundaries', async () => {
  assert.ok(process.env.DATABASE_URL && process.env.MIGRATION_DATABASE_URL && process.env.SYNTHETIC_PASSWORD, 'Explicit synthetic database configuration required; never skip integration');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
  const app = await buildApp({ pool, origin: 'http://localhost:3000', secret: 'synthetic-test-signing-key-32-characters', secure: true, reports: 'tenant-a' });
  const hashes: string[] = [];
  const created: string[] = [];
  const headers = { origin: 'http://localhost:3000' };
  async function login(username: string) {
    const response = await app.inject({ method: 'POST', url: '/api/login', headers, payload: { username, password: process.env.SYNTHETIC_PASSWORD! } });
    assert.equal(response.statusCode, 200);
    const set = String(response.headers['set-cookie']);
    assert.match(set, /HttpOnly/); assert.match(set, /Secure/); assert.match(set, /SameSite=Strict/);
    const session = response.cookies.find(c => c.name === 'session')!;
    hashes.push(tokenHash(app.unsignCookie(session.value).value!));
    return `session=${encodeURIComponent(session.value)}`;
  }
  try {
    assert.equal((await app.inject('/health')).statusCode, 200);
    assert.equal((await app.inject('/')).statusCode, 200);
    assert.equal((await app.inject('/app.js')).statusCode, 200);
    for (const path of ['/api/me','/api/records','/api/reports']) assert.equal((await app.inject(path)).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/login', headers, payload: { username: 'tenant-a-admin', password: 'wrong' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/login', headers, payload: { username: 'unknown', password: 'wrong' } })).statusCode, 401);
    const member = await login('tenant-a-member');
    const admin = await login('tenant-a-admin');
    const other = await login('tenant-b-admin');
    assert.equal((await app.inject({ url: '/api/me', headers: { cookie: `${admin}x` } })).statusCode, 401);
    assert.equal((await app.inject({ url: '/api/reports', headers: { cookie: member } })).statusCode, 403);
    assert.equal((await app.inject({ url: '/api/reports', headers: { cookie: other } })).statusCode, 404);
    assert.equal((await app.inject({ url: '/api/reports', headers: { cookie: admin } })).statusCode, 200);
    const before = (await owner.query('SELECT count(*) FROM records')).rows[0].count;
    assert.equal((await app.inject({ method: 'POST', url: '/api/records', headers: { ...headers, cookie: member }, payload: { title: 'denied' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/records', headers: { origin: 'https://untrusted.invalid', cookie: admin }, payload: { title: 'denied' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/records', headers: { ...headers, cookie: admin }, payload: { title: 'denied', tenant_id: 'tenant-b' } })).statusCode, 400);
    assert.equal((await owner.query('SELECT count(*) FROM records')).rows[0].count, before);
    const added = await app.inject({ method: 'POST', url: '/api/records', headers: { ...headers, cookie: admin }, payload: { title: 'Synthetic test record' } });
    assert.equal(added.statusCode, 201); created.push(added.json().id);
    assert.equal((await owner.query('SELECT tenant_id FROM records WHERE id=$1', [created[0]])).rows[0].tenant_id, 'tenant-a');
    const a = await app.inject({ url: '/api/records?tenant_id=tenant-b', headers: { cookie: admin, 'x-tenant-id': 'tenant-b' } });
    assert.ok(a.json().some((r: { id: string }) => r.id === created[0]));
    assert.ok(!a.json().some((r: { title: string }) => r.title === 'tenant-b sample'));
    const b = await app.inject({ url: '/api/records', headers: { cookie: other } });
    assert.ok(!b.json().some((r: { id: string }) => r.id === created[0]));
    assert.ok(b.json().some((r: { title: string }) => r.title === 'tenant-b sample'));
    await owner.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [hashes[0]]);
    assert.equal((await app.inject({ url: '/api/me', headers: { cookie: member } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/logout', headers: { ...headers, cookie: admin }, payload: {} })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/me', headers: { cookie: admin } })).statusCode, 401);
    // The single-connection pool makes context reuse deterministic.
    for (const table of ['records','accounts','sessions']) assert.equal((await pool.query(`SELECT * FROM ${table}`)).rowCount, 0);
  } finally {
    if (created.length) await owner.query("DELETE FROM records WHERE tenant_id='tenant-a' AND id=ANY($1::uuid[])", [created]);
    if (hashes.length) await owner.query('DELETE FROM sessions WHERE token_hash=ANY($1::text[])', [hashes]);
    await app.close(); await pool.end(); await owner.end();
  }
});

test('RLS rejects cross-tenant reads, writes and tenant hopping as actual runtime role', async () => {
  assert.ok(process.env.DATABASE_URL);
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await context(client, 'tenant_id', 'tenant-a');
    assert.equal((await client.query("SELECT * FROM records WHERE tenant_id='tenant-b'")).rowCount, 0);
    assert.ok((await client.query("SELECT * FROM records WHERE tenant_id='tenant-a'")).rowCount! > 0);
    for (const sql of ["UPDATE records SET title='denied' WHERE tenant_id='tenant-b'", "DELETE FROM records WHERE tenant_id='tenant-b'"]) assert.equal((await client.query(sql)).rowCount, 0);
    for (const [sql, values] of [
      ['INSERT INTO records(tenant_id,id,title) VALUES ($1,$2,$3)', ['tenant-b',randomUUID(),'denied']],
      ["UPDATE records SET tenant_id='tenant-b' WHERE tenant_id='tenant-a'", []],
      ["UPDATE accounts SET role='admin'", []],
      ["INSERT INTO accounts VALUES (gen_random_uuid(),'tenant-b','denied','denied','admin')", []],
      ["DELETE FROM accounts", []],
      ["UPDATE sessions SET expires_at=now()", []],
      ["INSERT INTO sessions VALUES ('forged',gen_random_uuid(),now())", []]
    ] as [string, string[]][]) {
      await client.query('SAVEPOINT negative');
      await assert.rejects(client.query(sql, values), (error: { code?: string }) => error.code === '42501');
      await client.query('ROLLBACK TO SAVEPOINT negative');
    }
    assert.equal((await client.query('SELECT * FROM accounts')).rowCount, 0);
    assert.equal((await client.query('SELECT * FROM sessions')).rowCount, 0);
    assert.equal((await client.query('DELETE FROM sessions')).rowCount, 0);
    const id = randomUUID();
    assert.equal((await client.query("INSERT INTO records VALUES ('tenant-a',$1,'positive')", [id])).rowCount, 1);
    assert.equal((await client.query("UPDATE records SET title='updated' WHERE id=$1", [id])).rowCount, 1);
    assert.equal((await client.query('DELETE FROM records WHERE id=$1', [id])).rowCount, 1);
  } finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
});
