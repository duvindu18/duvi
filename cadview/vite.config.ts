import { defineConfig } from 'vite';

// base './' so the bundle loads from inside the Android/iOS app shell.
// keepNames: acad-ts (DWG reader) maps CAD classes by their class names, which minification would rename.
export default defineConfig({
  base: './',
  esbuild: { keepNames: true },
  build: { target: 'es2020', chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
  test: { environment: 'node' },
} as any);
