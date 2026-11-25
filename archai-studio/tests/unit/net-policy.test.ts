import { describe, expect, it } from 'vitest'
import { checkUrl } from '@shared/net-policy'

const policy = { loopbackPorts: [11434, 8188] }

describe('network policy', () => {
  it.each([
    'http://127.0.0.1:11434/api/tags',
    'http://localhost:8188/system_stats',
    'ws://127.0.0.1:8188/ws?clientId=abc',
    'http://[::1]:11434/api/version'
  ])('allows local service %s', (url) => {
    expect(checkUrl(url, 'local-ai', policy).allowed).toBe(true)
  })

  it.each([
    ['http://192.168.1.20:11434/api/tags', 'loopback only'],
    ['http://127.0.0.1:22/', 'port 22'],
    ['https://127.0.0.1:11434/', 'protocol'],
    ['http://evil.com:11434/', 'loopback only'],
    ['http://127.0.0.1.evil.com:11434/', 'loopback only'],
    ['http://user:pw@127.0.0.1:11434/', 'credentials'],
    ['file:///C:/Windows/system32', 'protocol'],
    ['not a url', 'valid URL']
  ])('blocks %s', (url, why) => {
    const v = checkUrl(url, 'local-ai', policy)
    expect(v.allowed).toBe(false)
    expect(v.reason).toContain(why)
  })

  it('never lets local-ai reach GitHub', () => {
    expect(checkUrl('https://github.com/x/y', 'local-ai', policy).allowed).toBe(false)
  })

  it('allows GitHub hosts only for explicit purposes, https only', () => {
    expect(checkUrl('https://codeload.github.com/o/r/zip/refs/heads/main', 'github-import', policy).allowed).toBe(true)
    expect(checkUrl('http://codeload.github.com/o/r', 'github-import', policy).allowed).toBe(false)
    expect(checkUrl('https://github.com.evil.io/', 'github-import', policy).allowed).toBe(false)
    expect(checkUrl('https://raw.githubusercontent.com/o/r/main/x', 'github-import', policy).allowed).toBe(false)
    expect(checkUrl('https://api.github.com:8443/', 'update-check', policy).allowed).toBe(false)
  })

  it('respects port changes from Settings', () => {
    expect(checkUrl('http://127.0.0.1:9999/', 'local-ai', { loopbackPorts: [9999] }).allowed).toBe(true)
    expect(checkUrl('http://127.0.0.1:11434/', 'local-ai', { loopbackPorts: [9999] }).allowed).toBe(false)
  })
})
