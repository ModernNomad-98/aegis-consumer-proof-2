import { spawnSync } from 'node:child_process';
if (process.versions.node.split('.')[0] !== '22') throw new Error('Reproduce requires Node 22');
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' });
  if (result.error || result.status !== 0) throw new Error(`Required step failed: ${command}`);
}
if (!process.env.DATABASE_URL || !process.env.MIGRATION_DATABASE_URL || !process.env.SYNTHETIC_PASSWORD) throw new Error('Explicit synthetic database configuration required');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
run(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
for (const script of ['build','test','migrate','migrate','verify:migration','seed','test:integration']) run(npm, ['run', script]);
console.log('REPRODUCE PASS: build, units, repeat migration, verification, auth and RLS negatives');
