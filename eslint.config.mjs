// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
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
      "prettier/prettier": ["error", { endOfLine: "auto" }],
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
