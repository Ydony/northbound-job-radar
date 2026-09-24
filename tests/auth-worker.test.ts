import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { hashPassword } from '../lib/auth';

test('a hash generated during local admin setup verifies in the Workers runtime', async () => {
  const password = 'synthetic password for worker runtime';
  const hash = await hashPassword(password);
  assert.match(hash, /^pbkdf2\$100000\$/);
  const bundled = await build({
    stdin: {
      contents: `import { verifyPassword } from './lib/auth.ts';
        export default { async fetch(request) {
          const { password, hash } = await request.json();
          try { return Response.json({ matches: await verifyPassword(password, hash) }); }
          catch (error) { return Response.json({ error: String(error) }); }
        } };`,
      resolveDir: process.cwd(),
      sourcefile: 'auth-worker-fixture.ts',
      loader: 'ts',
    },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
  });
  const worker = new Miniflare({ modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: '2026-05-15' });
  try {
    const response = await worker.dispatchFetch('http://localhost/', { method: 'POST',
      body: JSON.stringify({ password, hash }) });
    assert.deepEqual(await response.json(), { matches: true });
  } finally {
    await worker.dispose();
  }
});
