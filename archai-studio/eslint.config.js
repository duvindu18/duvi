import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import globals from 'globals'

export default tseslint.config(
  { ignores: ['out/**', 'dist/**', 'node_modules/**', 'test-results/**', 'playwright-report/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The screen never talks to the network directly; everything goes through IPC.
      'no-restricted-globals': ['error', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource'],
      'no-restricted-imports': ['error', { patterns: ['electron', 'node:*', 'fs', 'path', 'child_process'] }]
    }
  },
  {
    files: ['src/main/**/*.ts'],
    rules: {
      // All main-process network calls must go through net-guard.ts (guardedFetch).
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Use guardedFetch from net-guard.ts' }, 'WebSocket'],
      'no-restricted-imports': ['error', { paths: ['http', 'https', 'node:http', 'node:https', 'node:net', 'net'] }]
    }
  }
)
