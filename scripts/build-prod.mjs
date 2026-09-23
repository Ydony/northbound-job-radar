#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const PROD_DATABASE_ID = 'b0a513c7-0d01-486c-8b16-5cdb6690c959';
const generatedConfig = resolve('dist/server/wrangler.json');
const childEnvironment = { ...process.env, IKBENEENAPPEL_ENV: 'prod' };

async function run(args) {
  const child = spawn(process.execPath, args, { env: childEnvironment, stdio: 'inherit' });
  const code = await new Promise((done) => child.on('exit', done));
  if (code !== 0) process.exit(code ?? 1);
}

await run([resolve('node_modules/vinext/dist/cli.js'), 'build']);

const config = JSON.parse(readFileSync(generatedConfig, 'utf8'));
const databases = config.d1_databases ?? [];
if (config.name !== 'ikbeneenappel-prod'
  || databases.length !== 1
  || databases[0].binding !== 'DB'
  || databases[0].database_name !== 'ikbeneenappel-prod'
  || databases[0].database_id !== PROD_DATABASE_ID
  || !config.compatibility_flags?.includes('nodejs_compat')) {
  throw new Error('Production build bindings do not match the approved Worker and D1. Refusing deploy.');
}
console.log('Production Worker/D1 binding verified.');

if (process.argv.includes('--deploy')) {
  await run([resolve('node_modules/wrangler/bin/wrangler.js'), 'deploy', '--config', generatedConfig]);
}
