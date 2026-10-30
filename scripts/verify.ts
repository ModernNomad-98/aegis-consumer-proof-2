import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { Pool, assertRuntime } from '../src/db.js';
const owner = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
const runtime = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  assert.ok(process.env.MIGRATION_DATABASE_URL && process.env.DATABASE_URL);
  assert.equal(Math.floor(Number((await owner.query('SHOW server_version_num')).rows[0].server_version_num) / 10000), 16);
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
  console.log('Migration checksum, PostgreSQL 16, forced RLS, policy inventory, runtime role and empty context verified');
} catch { console.error('Migration verification failed'); process.exitCode = 1; }
finally { await owner.end(); await runtime.end(); }
