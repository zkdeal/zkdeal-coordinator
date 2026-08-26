/**
 * Flat ESLint config for web/.
 *
 * The package declared `"lint": "eslint ."` while neither ESLint nor any
 * config was a dependency, so the lint gate could never start. This config
 * plus the devDependencies in package.json make it runnable, and the package
 * `build` script now runs it - a lint gate nothing invokes is the same as no
 * lint gate.
 *
 * Deliberately narrow: type-aware linting across the transpiled workspace
 * packages is a separate, slower gate. `tsc --noEmit` (pnpm typecheck) remains
 * the authority on types.
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['.next/**', 'out/**', 'next-env.d.ts', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        // DefinePlugin literal (see next.config.mjs).
        __ZKDEAL_TEST_HOOKS__: 'readonly',
      },
    },
    rules: {
      // Argument names starting with _ are intentionally unused.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Node tooling (build config + scripts) runs outside the browser bundle,
    // so it gets the Node/WHATWG globals the app code deliberately does not.
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
  },
)
