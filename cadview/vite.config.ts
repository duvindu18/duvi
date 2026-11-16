import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// base './' so the bundle loads from inside the Android/iOS app shell.
// keepNames: acad-ts (DWG reader) maps CAD classes by their class names, which minification would rename.
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(version) },
  esbuild: { keepNames: true },
  build: { target: 'es2020', chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
  test: { environment: 'node' },
} as any);
