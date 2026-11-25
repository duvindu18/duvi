import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

vi.mock('electron', () => ({ protocol: {} }))
const { resolveInside } = await import('../../src/main/protocol')

describe('app:// file serving', () => {
  const root = join('/opt', 'archai', 'renderer')
  it('serves files inside the renderer folder', () => {
    expect(resolveInside(root, '/')).toBe(join(root, 'index.html'))
    expect(resolveInside(root, '/assets/index.js')).toBe(join(root, 'assets', 'index.js'))
  })
  it.each(['/../main/index.js', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2fsecret', '/a%00b', '/%E0%A4%A'])('refuses %s', (p) => {
    expect(resolveInside(root, p)).toBeNull()
  })
})

describe('trusted sender check', async () => {
  const { isAppUrl } = await import('../../src/main/protocol')
  it('accepts only our app origin and the dev server', () => {
    expect(isAppUrl('app://archai/index.html')).toBe(true)
    expect(isAppUrl('app://evil/index.html')).toBe(false)
    expect(isAppUrl('https://archai/index.html')).toBe(false)
    expect(isAppUrl('http://localhost:5173/', 'http://localhost:5173')).toBe(true)
    expect(isAppUrl('http://localhost:5174/', 'http://localhost:5173')).toBe(false)
    expect(isAppUrl('http://localhost:5173/')).toBe(false)
    expect(isAppUrl('')).toBe(false)
  })
})
