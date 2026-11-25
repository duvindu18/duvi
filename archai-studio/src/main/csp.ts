/**
 * Content-Security-Policy for the screen. The renderer has no network access
 * of its own: everything goes through the main process via IPC.
 */
export function buildCsp(opts: { devServerOrigin?: string }): string {
  const dev = opts.devServerOrigin
  const devWs = dev ? dev.replace(/^http/, 'ws') : ''
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    // Dev only: Vite's React refresh needs one inline script. Never in packaged builds.
    'script-src': ["'self'", ...(dev ? [dev, "'unsafe-inline'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:', 'archai-img:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': ["'self'", ...(dev ? [dev, devWs] : [])],
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'frame-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"]
  }
  return Object.entries(directives)
    .map(([k, v]) => `${k} ${v.join(' ')}`)
    .join('; ')
}
