import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { Pool, assertRuntime } from '../src/db.js';
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const runtime = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  assert.ok(process.env.MIGRATION_DATABASE_URL && process.env.DATABASE_URL);
  // Owner disposition O3 (2026-10-30 21:02 PDT): accept PostgreSQL major 16 or
  // newer and record the observed server version; the hosted database is not
  // downgraded. The minimum major is enforced from server_version_num.
  const observedVersion = (await owner.query('SHOW server_version')).rows[0].server_version;
  const observedMajor = Math.floor(Number((await owner.query('SHOW server_version_num')).rows[0].server_version_num) / 10000);
  assert.ok(Number.isInteger(observedMajor) && observedMajor >= 16, 'PostgreSQL major 16 or newer required; observed ' + String(observedMajor));
  const checksum = createHash('sha256').update(await readFile('migrations/001_initial.sql')).digest('hex');
  assert.deepEqual((await owner.query('SELECT version,checksum FROM schema_migrations')).rows, [{ version: '001_initial', checksum }]);
  const tables = (await owner.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('accounts'::regclass,'sessions'::regclass,'records'::regclass) ORDER BY relname")).rows;
  assert.equal(tables.length, 3);
  assert.ok(tables.every(t => t.relrowsecurity && t.relforcerowsecurity));
  const policies = (await owner.query("SELECT policyname FROM pg_policies WHERE schemaname='public' ORDER BY policyname")).rows.map(r => r.policyname);
  assert.deepEqual(policies, ['account_read','maintenance','maintenance','maintenance','record_scope','session_delete','session_insert','session_read']);
  await assertRuntime(runtime);
  assert.equal((await runtime.query('SELECT * FROM records')).rowCount, 0);
  assert.equal((await runtime.query('SELECT * FROM accounts')).rowCount, 0);
  assert.equal((await runtime.query('SELECT * FROM sessions')).rowCount, 0);
  console.log('Migration checksum, PostgreSQL ' + String(observedVersion) + ' (major ' + String(observedMajor) + ' >= 16 accepted), forced RLS, policy inventory, runtime role and empty context verified');
} catch { console.error('Migration verification failed'); process.exitCode = 1; }
finally { await owner.end(); await runtime.end(); }
