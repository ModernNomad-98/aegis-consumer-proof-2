import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/password.js';
import { reportsEnabled } from '../src/flags.js';
test('scrypt verifies correct passwords, denies wrong passwords and uses independent salts', async () => {
  const first = await hashPassword('synthetic-password');
  assert.equal(await verifyPassword('synthetic-password', first), true);
  assert.equal(await verifyPassword('wrong-password', first), false);
  assert.notEqual(first, await hashPassword('synthetic-password'));
  assert.equal(await verifyPassword('synthetic-password', 'malformed'), false);
});
test('reports config fails closed and targets tenants explicitly', () => {
  assert.equal(reportsEnabled('tenant-a', undefined), false);
  assert.equal(reportsEnabled('tenant-a', 'true'), false);
  assert.equal(reportsEnabled('tenant-a', 'tenant-a'), true);
  assert.equal(reportsEnabled('tenant-b', 'tenant-a'), false);
  assert.equal(reportsEnabled('unknown', 'unknown'), false);
});
