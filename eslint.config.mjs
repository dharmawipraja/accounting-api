// @ts-check
import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    // Generated output (build, coverage reports) is never linted.
    ignores: [
      'eslint.config.mjs',
      'dist/**',
      'build/**',
      'coverage/**',
      'coverage-e2e/**',
      'coverage-merged/**',
      '.nyc_output/**',
      '.superpowers/**',
      '.claude/**', // agent git worktrees
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { varsIgnorePattern: '^_', argsIgnorePattern: '^_' },
      ],
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  {
    // Plain JS files sit outside every tsconfig, so type-aware rules can't run
    // on them; lint them with the syntactic rules only.
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Operational scripts run by bare node (CommonJS, e.g. the migrate image).
    files: ['scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    // k6 load-test scripts: ES modules executed by the k6 runtime.
    files: ['perf/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' },
    },
  },
  {
    // Every interactive transaction in src/ must go through
    // PrismaService.transaction(): it marks the request's Idempotency-Key
    // committed inside the tx, which is what stops a retry from re-executing a
    // committed write. A raw `$transaction(` silently loses that guarantee.
    files: ['src/**/*.ts'],
    ignores: ['src/common/prisma/prisma.service.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='$transaction']",
          message:
            'Use this.prisma.transaction(fn, opts) — it marks the idempotency key committed inside the tx. Raw $transaction( is only allowed in prisma.service.ts.',
        },
      ],
    },
  },
);
