import { Pool } from './db.js';
import { buildApp } from './app.js';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
try {
  if (!process.env.DATABASE_URL || !process.env.APP_ORIGIN) throw new Error('Missing configuration');
  const app = await buildApp({ pool, secret: process.env.SESSION_SECRET ?? '', origin: process.env.APP_ORIGIN, secure: process.env.NODE_ENV === 'production', reports: process.env.REPORTS_TENANTS, revision: process.env.RENDER_GIT_COMMIT });
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await app.close(); await pool.end(); });
} catch { console.error('Startup failed; check required configuration and database permissions'); await pool.end(); process.exitCode = 1; }
