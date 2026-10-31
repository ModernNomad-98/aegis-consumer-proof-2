import { randomUUID } from 'node:crypto';
import { Pool, transaction } from '../src/db.js';
import { hashPassword } from '../src/password.js';
const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
try {
  const password = process.env.SYNTHETIC_PASSWORD;
  if (!process.env.MIGRATION_DATABASE_URL || !password || password.length < 16) throw new Error('Synthetic password required');
  await transaction(pool, async client => {
    for (const tenant of ['tenant-a','tenant-b']) {
      for (const role of ['member','admin']) {
        await client.query('INSERT INTO accounts(id,tenant_id,username,password_hash,role) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(username) DO NOTHING', [randomUUID(),tenant,`${tenant}-${role}`,await hashPassword(password),role]);
      }
      await client.query('INSERT INTO records(tenant_id,id,title) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [tenant, '00000000-0000-4000-8000-000000000001', `${tenant} sample`]);
    }
  });
  console.log('Synthetic fixtures present; existing passwords unchanged');
} catch { console.error('Synthetic fixture setup failed'); process.exitCode = 1; }
finally { await pool.end(); }
