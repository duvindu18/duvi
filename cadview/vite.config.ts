import { defineConfig } from 'vite';

// base './' so the bundle loads from file:// inside the Android/iOS app shell.
export default defineConfig({
  base: './',
  build: { target: 'es2020', chunkSizeWarningLimit: 1500 },
  worker: { format: 'es' },
  test: { environment: 'node' },
} as any);
