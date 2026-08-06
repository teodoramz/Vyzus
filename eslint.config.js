// Flat config (ESLint 9). Type-aware linting is deliberately NOT enabled:
// `pnpm typecheck` already runs the full TypeScript compiler over every
// workspace, so duplicating that here would double CI time for no new
// signal. This config catches what tsc does not: unused code, React hook
// dependency mistakes, accidental `any`, and stale eslint-disable comments.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/drizzle/**',
      'eslint.config.js',
      '**/vitest.config.ts',
      '**/tsup.config.ts',
      '**/vite.config.ts',
      '**/tailwind.config.js',
      '**/postcss.config.js',
      '**/drizzle.config.ts',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Everything here runs on Node or in the browser; without this the
    // no-undef rule flags `process`, `console`, `fetch`, `window`, etc.
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    linterOptions: {
      // A stale `eslint-disable` is a small lie about the code — surface it.
      reportUnusedDisableDirectives: 'warn',
    },
    rules: {
      // Underscore prefix is the established "intentionally unused" marker in
      // this codebase (e.g. `_payload` in the no-op scheduler impl).
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // Recharts render-props and Fastify schema generics are typed loosely
      // upstream; the few deliberate `any`s sit at those boundaries and are
      // commented at the call site.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['apps/dashboard/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // Warn, not error: several effects here intentionally omit a dep to run
      // once (each carries an inline comment explaining why), and those are
      // reviewed case by case rather than blanket-silenced.
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Operator tooling and tests — console output is the point.
    files: ['scripts/**', 'apps/api/src/seed-demo.ts', '**/*.test.ts', '**/test/**'],
    rules: { 'no-console': 'off' },
  },
  prettier,
);
