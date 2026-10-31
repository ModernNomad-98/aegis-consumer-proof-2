import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
const params = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, params, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string) {
  const [kind, salt, hash] = encoded.split('$');
  if (kind !== 'scrypt' || !salt || !/^[a-f0-9]{32}$/.test(salt) || !hash || !/^[a-f0-9]{128}$/.test(hash)) return false;
  return timingSafeEqual(await derive(password, salt), Buffer.from(hash, 'hex'));
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
