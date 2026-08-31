#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const environment = process.argv[2];
if (environment !== 'dev' && environment !== 'test') {
  console.error('Usage: node scripts/run-local.mjs <dev|test>');
  process.exit(1);
}

const varsFile = `.dev.vars.${environment}`;
if (!existsSync(varsFile)) {
  const init = spawn(
    process.execPath,
    [resolve('scripts/init-secrets.mjs'), environment],
    { stdio: 'inherit' },
  );
  const initExitCode = await new Promise((done) => init.on('exit', done));
  if (initExitCode !== 0) process.exit(initExitCode ?? 1);
}

const vinextCli = resolve('node_modules/vinext/dist/cli.js');
const childEnvironment = {
  ...process.env,
  IKENGELS_ENV: environment,
  ...(environment === 'dev' ? { CLOUDFLARE_ENV: 'dev' } : {}),
};

if (environment === 'test') {
  console.log('Building the stable local test release...');
  const build = spawn(process.execPath, [vinextCli, 'build'], {
    env: childEnvironment,
    stdio: 'inherit',
  });
  const buildExitCode = await new Promise((done) => build.on('exit', done));
  if (buildExitCode !== 0) process.exit(buildExitCode ?? 1);
}

const serverArguments = environment === 'test'
  ? [
      resolve('node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--config',
      resolve('dist/server/wrangler.json'),
      '--ip',
      '127.0.0.1',
      '--port',
      '3001',
      '--persist-to',
      resolve('.wrangler/test/state'),
      '--env-file',
      resolve('.dev.vars.test'),
      '--show-interactive-dev-session',
      'false',
  ]
  : [vinextCli, 'dev'];
const server = spawn(process.execPath, serverArguments, {
  env: childEnvironment,
  stdio: 'inherit',
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.kill(signal));
}

const exitCode = await new Promise((done) => server.on('exit', done));
process.exit(exitCode ?? 1);
