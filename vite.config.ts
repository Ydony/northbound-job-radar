import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import hostingConfig from './.openai/hosting.json';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

// Real remote D1, created once with `wrangler d1 create ikbeneenappel-prod`. Never point this at
// TEST data (docs/DEPLOY.md) - it starts empty and is bootstrapped by scripts/bootstrap-prod-admin.mjs.
const PROD_DATABASE_ID = 'b0a513c7-0d01-486c-8b16-5cdb6690c959';

// The binding names live in .openai/hosting.json because that is where the scaffolding that
// created this project put them. The file is kept and read - it names DB -
// but the @openai/sites-vite-plugin that came with it is gone: the project deploys to Cloudflare
// and docs/DEPLOY.md rules out OpenAI Sites outright, so the plugin was building for a target
// nobody intends to use. The remaining binding is the local D1 database.
const { d1 } = hostingConfig;
const appEnvironment = process.env.IKBENEENAPPEL_ENV === 'test'
  ? 'test'
  : process.env.IKBENEENAPPEL_ENV === 'prod'
    ? 'prod'
    : 'dev';
const isProd = appEnvironment === 'prod';
const localStateDirectory = `.wrangler/${appEnvironment}`;
const localPort = appEnvironment === 'test' ? 3001 : 3000;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const localBindingConfig = {
  ...(isProd ? {
    name: 'ikbeneenappel-prod',
    workers_dev: true,
    routes: [{ pattern: 'ikbeneenappel.nl', custom_domain: true }],
  } : {}),
  main: 'worker/entry.ts',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: isProd ? 'ikbeneenappel-prod' : 'site-creator-d1',
          database_id: isProd ? PROD_DATABASE_ID : SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  // Native edge rate limiter for the auth endpoints (#171): a per-location burst brake in front
  // of the exact database budgets. The window can only be 10 or 60 seconds, so the 15-minute
  // sign-in budgets stay in D1; this binding only absorbs floods. Absent locally, the app falls
  // back to the database limiter alone — see lib/guard.ts. The namespace id must stay unique
  // within the Cloudflare account; bindings sharing one share their counters.
  ratelimits: [
    {
      name: 'AUTH_RATE_LIMIT',
      namespace_id: '17101',
      simple: { limit: 30, period: 60 as const },
    },
  ],
  // INT-06 (#165) bounded public refresh: Cloudflare Cron Triggers (native Workers
  // feature). Prod only — dev/test stay synthetic with no schedule — and fail-closed
  // behind PUBLIC_REFRESH_ENABLED plus owner-configured PUBLIC_REFRESH_TERMS (see
  // lib/public-refresh-scheduler.ts). The schedule itself is provisional until
  // collection costs are measured (plan §4). Deploying is owner-supervised.
  ...(isProd
    ? { triggers: { crons: ['0 */6 * * *'] } }
    : {}),
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= `${localStateDirectory}/logs`;
  process.env.MINIFLARE_REGISTRY_PATH ??= `${localStateDirectory}/registry`;

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');

  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: {
      host: '127.0.0.1',
      port: localPort,
      strictPort: true,
      ...(isCodexSeatbeltSandbox
        ? { watch: { useFsEvents: false, usePolling: true } }
        : {}),
    },
    preview: {
      host: '127.0.0.1',
      port: localPort,
      strictPort: true,
    },
    plugins: [
      vinext(),
      cloudflare({
        persistState: { path: `${localStateDirectory}/state` },
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: localBindingConfig,
      }),
    ],
  };
});
