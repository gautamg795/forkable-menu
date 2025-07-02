import js from '@eslint/js';
import convex from '@convex-dev/eslint-plugin';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  js.configs.recommended,
  {
    files: ['convex/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      '@convex-dev': convex,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@convex-dev/no-old-registered-function-syntax': 'error',
      '@convex-dev/no-missing-args-validator': 'error',
    },
  },
];