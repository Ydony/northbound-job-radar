import { defineConfig, globalIgnores } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import nextTs from 'eslint-config-next/typescript';

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores(['.next/**', 'out/**', 'build/**', 'next-env.d.ts']),
  {
    rules: {
      /**
       * This rule wants `next/link` for internal navigation. vinext 1.0.0-beta.3 ships a Link shim
       * that throws `TypeError: e is not a function` from its client chunk the moment a link is
       * clicked, so navigation silently did nothing while the href looked correct on hover. Plain
       * anchors do a full page load, which works, and costs nothing here: every internal
       * destination is a different page with its own data, so there is no client-side transition
       * worth preserving. Revisit if vinext fixes Link.
       */
      '@next/next/no-html-link-for-pages': 'off',
    },
  },
]);

export default eslintConfig;
