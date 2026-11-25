/**
 * Serves the built screen files from a private `app://archai/` origin instead
 * of file://, so the CSP header applies and paths can't escape the app folder.
 */
import { protocol } from 'electron'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, relative, isAbsolute } from 'node:path'

export const APP_SCHEME = 'app'
export const APP_ORIGIN = 'app://archai'

export function registerSchemesAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }
  ])
}

/**
 * True if url belongs to our app (or to the dev server in development).
 * Note: Node's URL reports origin "null" for custom schemes, so compare parts.
 */
export function isAppUrl(rawUrl: string, devServerOrigin?: string): boolean {
  try {
    const u = new URL(rawUrl)
    if (u.protocol === `${APP_SCHEME}:` && u.host === 'archai') return true
    return devServerOrigin !== undefined && (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === devServerOrigin
  } catch {
    return false
  }
}

/** Returns an absolute file path inside root, or null if the request escapes it. */
export function resolveInside(root: string, urlPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const target = normalize(join(root, decoded === '/' || decoded === '' ? 'index.html' : decoded))
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return target
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm'
}

export function mimeFor(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export function handleAppProtocol(rendererRoot: string, csp: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url)
    if (url.host !== 'archai') return new Response('Not found', { status: 404 })
    const file = resolveInside(rendererRoot, url.pathname)
    if (!file) return new Response('Forbidden', { status: 403 })
    try {
      const body = await readFile(file)
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': mimeFor(file), 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' }
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
