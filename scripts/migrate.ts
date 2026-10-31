import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Pool, transaction } from '../src/db.js';
const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
try {
  if (!process.env.MIGRATION_DATABASE_URL || !process.env.DATABASE_URL) throw new Error('Missing configuration');
  const runtime = decodeURIComponent(new URL(process.env.DATABASE_URL).username);
  const migration = decodeURIComponent(new URL(process.env.MIGRATION_DATABASE_URL).username);
  if (runtime === migration || !/^[a-z_][a-z0-9_]*$/.test(runtime)) throw new Error('Separate runtime identity required');
  const sql = await readFile('migrations/001_initial.sql', 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  await transaction(pool, async client => {
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='60s'");
    await client.query('SELECT pg_advisory_xact_lock(72614001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, checksum text NOT NULL)');
    const old = (await client.query("SELECT checksum FROM schema_migrations WHERE version='001_initial'")).rows[0];
    if (old && old.checksum !== checksum) throw new Error('Migration checksum mismatch');
    if (!old) {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations VALUES ($1,$2)', ['001_initial', checksum]);
    }
    await client.query(`GRANT app_runtime TO "${runtime}"`);
  });
  console.log('Migration applied or checksum-verified');
} catch { console.error('Migration failed; details withheld to protect connection secrets'); process.exitCode = 1; }
finally { await pool.end(); }
