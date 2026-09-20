import typescriptEslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import globals from 'globals';

const sourceFiles = ['src/**/*.ts'];

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'public/**', 'e2e/**']
  },
  {
    files: sourceFiles,
    languageOptions: {
      parser: tsParser,
      parserOptions: {project: './tsconfig.json'},
      sourceType: 'module',
      globals: globals.browser
    },
    plugins: {'@typescript-eslint': typescriptEslint},
    rules: {
      'prefer-const': 'error',
      '@typescript-eslint/no-explicit-any': 'off'
    }
  }
];
