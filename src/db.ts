import pg from 'pg';
export const { Pool } = pg;
export type Client = pg.PoolClient;
export async function transaction<T>(pool: pg.Pool, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function context(client: Client, key: 'login' | 'user_id' | 'token_hash' | 'tenant_id', value: string) {
  await client.query('SELECT set_config($1, $2, true)', [`app.${key}`, value]);
}
export async function assertRuntime(pool: pg.Pool) {
  const result = await pool.query(`SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole,
    EXISTS (SELECT 1 FROM pg_roles reachable WHERE
      pg_has_role(current_user,reachable.oid,'MEMBER') AND
      (reachable.rolsuper OR reachable.rolbypassrls OR reachable.rolcreaterole)) AS elevated,
    EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND pg_has_role(current_user,c.relowner,'MEMBER')) AS owns
    FROM pg_roles r WHERE rolname=current_user`);
  const role = result.rows[0];
  if (!role || role.rolsuper || role.rolbypassrls || role.rolcreaterole || role.elevated || role.owns) throw new Error('Unsafe runtime database role');
}
