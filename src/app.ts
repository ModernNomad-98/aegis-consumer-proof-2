import Fastify, { type FastifyError } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import { transaction, context, assertRuntime, type Client } from './db.js';
import { hashPassword, verifyPassword, tokenHash } from './password.js';
import { reportsEnabled } from './flags.js';
type Identity = { id: string; tenant_id: string; role: 'member' | 'admin' };
type Options = { pool: pg.Pool; secret: string; origin: string; secure: boolean; reports?: string; revision?: string };
export async function buildApp(options: Options) {
  if (options.secret.length < 32) throw new Error('SESSION_SECRET requires at least 32 characters');
  await assertRuntime(options.pool);
  const app = Fastify({ logger: false, bodyLimit: 8192, ajv: { customOptions: { removeAdditional: false } } });
  await app.register(cookie, { secret: options.secret, algorithm: 'sha256' });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  const dummy = await hashPassword(randomBytes(32).toString('hex'));
  const cookieOptions = { path: '/', httpOnly: true, secure: options.secure, sameSite: 'strict' as const, signed: true, maxAge: 3600 };
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.headers.origin !== options.origin) {
      return reply.code(403).send({ error: 'Origin denied' });
    }
  });
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status = error.statusCode && error.statusCode < 500 ? error.statusCode : 500;
    reply.code(status).send({ error: status === 500 ? 'Request failed' : 'Invalid request' });
  });
  async function identity(client: Client, raw: string | undefined): Promise<Identity | undefined> {
    if (!raw) return;
    const signed = app.unsignCookie(raw);
    if (!signed.valid || !signed.value || !/^[a-f0-9]{64}$/.test(signed.value)) return;
    await context(client, 'token_hash', tokenHash(signed.value));
    const session = (await client.query('SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at > now()', [tokenHash(signed.value)])).rows[0];
    if (!session) return;
    await context(client, 'user_id', session.user_id);
    const user = (await client.query('SELECT id, tenant_id, role FROM accounts WHERE id=$1', [session.user_id])).rows[0] as Identity | undefined;
    if (user) await context(client, 'tenant_id', user.tenant_id);
    return user;
  }
  app.get('/health', async () => { await options.pool.query('SELECT 1'); return { status: 'ok', revision: options.revision ?? 'local' }; });
  for (const [url, file, type] of [['/', 'index.html', 'text/html'], ['/app.js', 'app.js', 'text/javascript'], ['/style.css', 'style.css', 'text/css']]) {
    app.get(url!, async (_, reply) => reply.type(type!).send(await readFile(`public/${file}`, 'utf8')));
  }
  app.post<{ Body: { username: string; password: string } }>('/api/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: { body: { type: 'object', additionalProperties: false, required: ['username', 'password'], properties: { username: { type: 'string', minLength: 1, maxLength: 80 }, password: { type: 'string', minLength: 1, maxLength: 256 } } } }
  }, async (request, reply) => transaction(options.pool, async client => {
    await context(client, 'login', request.body.username);
    const account = (await client.query('SELECT * FROM accounts WHERE username=$1', [request.body.username])).rows[0];
    const valid = await verifyPassword(request.body.password, account?.password_hash ?? dummy);
    if (!account || !valid) return reply.code(401).send({ error: 'Invalid credentials' });
    // Re-login rotates this browser's previous session.
    await identity(client, request.cookies.session);
    await client.query('DELETE FROM sessions WHERE token_hash=current_setting(\'app.token_hash\',true)');
    const token = randomBytes(32).toString('hex');
    await context(client, 'user_id', account.id);
    await context(client, 'token_hash', tokenHash(token));
    await client.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [tokenHash(token), account.id]);
    reply.setCookie('session', token, cookieOptions);
    return { ok: true };
  }));
  app.post('/api/logout', async (request, reply) => transaction(options.pool, async client => {
    await identity(client, request.cookies.session);
    await client.query("DELETE FROM sessions WHERE token_hash=current_setting('app.token_hash',true)");
    reply.clearCookie('session', { path: '/' }); return { ok: true };
  }));
  app.get('/api/me', async (request, reply) => transaction(options.pool, async client => {
    const user = await identity(client, request.cookies.session);
    return user ? { ...user, reports: user.role === 'admin' && reportsEnabled(user.tenant_id, options.reports) } : reply.code(401).send({ error: 'Sign in required' });
  }));
  app.get('/api/records', async (request, reply) => transaction(options.pool, async client => {
    const user = await identity(client, request.cookies.session);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    return (await client.query('SELECT id,title FROM records WHERE tenant_id=$1 ORDER BY title LIMIT 100', [user.tenant_id])).rows;
  }));
  app.post<{ Body: { title: string } }>('/api/records', {
    schema: { body: { type: 'object', required: ['title'], additionalProperties: false, properties: { title: { type: 'string', minLength: 1, maxLength: 120, pattern: '\\S' } } } }
  }, async (request, reply) => transaction(options.pool, async client => {
    const user = await identity(client, request.cookies.session);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Admin required' });
    const result = await client.query('INSERT INTO records(tenant_id,id,title) VALUES ($1,$2,$3) RETURNING id,title', [user.tenant_id, randomUUID(), request.body.title.trim()]);
    reply.code(201); return result.rows[0];
  }));
  app.get('/api/reports', async (request, reply) => transaction(options.pool, async client => {
    const user = await identity(client, request.cookies.session);
    if (!user) return reply.code(401).send({ error: 'Sign in required' });
    if (user.role !== 'admin') return reply.code(403).send({ error: 'Admin required' });
    if (!reportsEnabled(user.tenant_id, options.reports)) return reply.code(404).send({ error: 'Reports unavailable' });
    return { records: Number((await client.query('SELECT count(*) FROM records WHERE tenant_id=$1', [user.tenant_id])).rows[0].count) };
  }));
  return app;
}
