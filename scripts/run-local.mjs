#!/usr/bin/env node
/**
 * The local environments: DEV on :3000 and TEST on :3001, both on the new stack.
 *
 * Owner decision, 2026-09-27: dev and test run the self-hosted target - the standalone Node bundle
 * on SQLite, which is what the VPS will run - and the Cloudflare/workerd path is archived. It has
 * not been deleted, because production still runs it until cutover (#201): `npm run dev:cloudflare`
 * and `npm run test:cloudflare` are the same two environments on the old runtime, and that is the
 * pair to reach for when checking something against what production serves *today*.
 *
 * The old D1 state under `.wrangler/` is not carried over, deliberately. Data only matters in
 * production; locally an empty database is better, because search has to actually run to fill it.
 *
 * **No hot reload here.** `vinext dev` gave it, and it cannot: HMR runs the app inside workerd,
 * where `node:sqlite` does not exist. So a change means `npm run dev` again, after a build that
 * takes a few seconds. `npm run dev:cloudflare` still has HMR if that is what a piece of work
 * needs, at the price of not being the stack that will ship.
 *
 * Each environment keeps its own database and its own session secret under `.local/`, so dev and
 * test cannot see each other's accounts or jobs - the same separation the two wrangler state
 * directories used to give. Delete a database file to start that environment over.
 *
 * Configuration comes from `.dev.vars.<env>`, the same files the Cloudflare target reads. The
 * standalone bundle only knows `process.env` - `.dev.vars.*` is a wrangler feature - so without
 * this the new stack would run with no Adzuna, Careerjet or Indeed configuration while the old one
 * had it, and a comparison between them would be comparing two different installations rather than
 * two runtimes. With nothing configured, every source simply reports itself unavailable.
 *
 * `npm run verify:selfhosted` deliberately does NOT read those files: the automated harness stays
 * credential-free so it can run anywhere without contacting a provider.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const environment = process.argv[2];
if (environment !== 'dev' && environment !== 'test') {
  console.error('Usage: node scripts/run-local.mjs <dev|test>');
  process.exit(1);
}

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const builtBundle = join(root, 'dist', 'standalone');
const localDir = join(root, '.local');
// Each environment serves its OWN copy of the bundle. Sharing `dist/standalone` looked fine and
// is not: chunk filenames are content-hashed, so building for one environment deletes the exact
// chunk names the other is lazily importing. DEV's build broke TEST's `/api/state` into a 500
// (`Cannot find module ... app-route-handler-dispatch-<hash>.js`) while TEST appeared to be
// running normally - pages still served, because they were already loaded. A copy costs a few
// seconds and about 30MB per environment, and makes each one immune to the other's rebuild.
const serveDir = join(localDir, `${environment}-server`);
const bundle = join(serveDir, 'server.js');
const databasePath = join(localDir, `${environment}.sqlite`);
const secretPath = join(localDir, `${environment}-session-secret`);
const port = Number(process.env.PORT ?? (environment === 'dev' ? 3000 : 3001));

/**
 * Read `.dev.vars.<env>` the way wrangler does, so both targets share one configuration.
 *
 * Deliberately minimal: `KEY=value`, `#` comments, blank lines, and one level of surrounding
 * quotes. Not a dotenv implementation - no interpolation, no multi-line values, no `export`. If
 * the file ever needs those it has outgrown being read by hand, and wrangler's own parser should
 * be used instead. Values are returned, never printed.
 */
function readVars(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const split = trimmed.indexOf('=');
    if (split < 1) continue;
    const key = trimmed.slice(0, split).trim();
    let value = trimmed.slice(split + 1).trim();
    if (value.length > 1 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value !== '') values[key] = value;
  }
  return values;
}

async function run(command, args, env) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit', env });
  return new Promise((done) => child.on('exit', done));
}

const vars = readVars(join(root, `.dev.vars.${environment}`));

// Always build. A running server is not proof of a current build - that has cost this project a
// silent no-op production deploy - and without HMR the build is the only thing that picks up an
// edit. It takes a few seconds.
console.log(`Building the standalone bundle for ${environment.toUpperCase()}...`);
const built = await run(process.execPath, [join(root, 'node_modules', 'vinext', 'dist', 'cli.js'), 'build'], {
  ...process.env,
  IKBENEENAPPEL_ENV: environment,
});
if (built !== 0) {
  console.error('\nBuild failed, so nothing was started.');
  console.error('`EPERM ... dist` means another server still holds the folder: stop it, then try again.');
  process.exit(built ?? 1);
}
if (!existsSync(join(builtBundle, 'server.js'))) {
  console.error(`The build produced no ${builtBundle}/server.js. next.config.ts must keep output: 'standalone'.`);
  process.exit(1);
}

mkdirSync(localDir, { recursive: true });
// Replace this environment's copy wholesale rather than merging into it, so a chunk that no longer
// exists in the build cannot linger and be served.
rmSync(serveDir, { recursive: true, force: true });
cpSync(builtBundle, serveDir, { recursive: true });
// Kept in a file rather than regenerated per start: a new secret invalidates every session, so
// restarting would sign you out and look like a bug.
if (!existsSync(secretPath)) writeFileSync(secretPath, randomBytes(48).toString('base64'), 'utf8');

const fresh = !existsSync(databasePath);
console.log(`\n${environment.toUpperCase()} (Node + SQLite) on http://127.0.0.1:${port}`);
console.log(`Database ${databasePath}${fresh ? ' - new and empty' : ''}`);
console.log(`Serving  ${serveDir} (this environment's own copy of the build)`);
if (fresh) console.log('Register the first account on this address to become its administrator.');
console.log(Object.keys(vars).length
  ? `Configuration .dev.vars.${environment}, ${Object.keys(vars).length} value(s)`
  : `Configuration none (.dev.vars.${environment} is absent), so every source reports itself unavailable`);
console.log('No hot reload on this stack: rerun this command after a change. Ctrl+C to stop.\n');

const server = spawn(process.execPath, [bundle], {
  cwd: root,
  stdio: 'inherit',
  env: {
    // The vars file first, then real shell variables, so a one-off override still wins.
    ...vars,
    ...process.env,
    IKBENEENAPPEL_ENV: environment,
    PORT: String(port),
    HOST: '127.0.0.1',
    SQLITE_PATH: databasePath,
    SESSION_SECRET: vars.SESSION_SECRET ?? readFileSync(secretPath, 'utf8').trim(),
  },
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal));
server.on('exit', (code) => process.exit(code ?? 0));
