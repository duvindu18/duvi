import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { buildCsp } from './src/main/csp'

/** Production builds also carry the CSP as a <meta> tag (belt and braces with the header). */
function cspMeta(): Plugin {
  return {
    name: 'archai-csp-meta',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${buildCsp({}).replace(/; frame-ancestors 'none'/, '')}" />`)
  }
}

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: { rolldownOptions: { input: { index: resolve('src/main/index.ts') } } }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      // Sandboxed preloads must be a single CommonJS file with no node_modules imports.
      externalizeDeps: false,
      rolldownOptions: {
        input: { index: resolve('src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/renderer/src') } },
    plugins: [react(), cspMeta()],
    build: { minify: true, rolldownOptions: { input: { index: resolve('src/renderer/index.html') } } }
  }
})
