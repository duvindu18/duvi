import { describe, expect, it } from 'vitest'
import { buildCsp } from '../../src/main/csp'

describe('Content-Security-Policy', () => {
  const prod = buildCsp({})
  it('gives the screen no network access of its own', () => {
    expect(prod).toContain("connect-src 'self';")
    expect(prod).not.toMatch(/127\.0\.0\.1|localhost|https?:/)
  })
  it('allows no inline or remote scripts in packaged builds', () => {
    expect(prod).toContain("script-src 'self';")
    expect(prod).not.toContain('unsafe-eval')
  })
  it('blocks objects, frames, base tags and forms', () => {
    for (const d of ["object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"]) expect(prod).toContain(d)
  })
  it('only loosens for the local dev server', () => {
    const dev = buildCsp({ devServerOrigin: 'http://localhost:5173' })
    expect(dev).toContain('connect-src \'self\' http://localhost:5173 ws://localhost:5173')
  })
})
