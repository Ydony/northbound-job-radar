import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig } from 'vite';
import hostingConfig from './.openai/hosting.json';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

// The binding names live in .openai/hosting.json because that is where the scaffolding that
// created this project put them. The file is kept and read - it is what names DB and CV_FILES -
// but the @openai/sites-vite-plugin that came with it is gone: the project deploys to Cloudflare
// and docs/DEPLOY.md rules out OpenAI Sites outright, so the plugin was building for a target
// nobody intends to use. Verified by removing it: the worker builds, both bindings are still
// declared, and the app reads D1 and R2 normally.
const { d1, r2 } = hostingConfig;
const localEnvironment = process.env.IKBENEENAPPEL_ENV === 'test' ? 'test' : 'dev';
const localStateDirectory = `.wrangler/${localEnvironment}`;
const localPort = localEnvironment === 'test' ? 3001 : 3000;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const localBindingConfig = {
  main: 'vinext/server/app-router-entry',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
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
