/**
 * The ONLY way the main process may make network requests.
 * Global `fetch` is banned elsewhere in src/main by ESLint.
 */
import { checkUrl, type NetPolicy, type NetPurpose } from '@shared/net-policy'
import { log } from './log'

let policy: NetPolicy = { loopbackPorts: [11434, 8188] }

export function setNetPolicy(next: NetPolicy): void {
  policy = { loopbackPorts: [...next.loopbackPorts] }
}

export function getNetPolicy(): NetPolicy {
  return { loopbackPorts: [...policy.loopbackPorts] }
}

export class NetBlockedError extends Error {
  constructor(
    public readonly url: string,
    public readonly reason: string
  ) {
    super(`Blocked by network guard: ${reason}`)
    this.name = 'NetBlockedError'
  }
}

export async function guardedFetch(url: string, purpose: NetPurpose, init?: RequestInit, opts: { followRedirects?: boolean } = {}): Promise<Response> {
  const verdict = checkUrl(url, purpose, policy)
  if (!verdict.allowed) {
    log.warn(`net-guard blocked ${purpose} request: ${verdict.reason}`)
    throw new NetBlockedError(url, verdict.reason)
  }
  // Redirects could leave the allow-list, so they are followed manually and re-checked.
  let current = url
  for (let hop = 0; hop < 5; hop++) {
    // eslint-disable-next-line no-restricted-globals -- this is the guarded wrapper
    const res = await fetch(current, { ...init, redirect: 'manual' })
    if (res.status < 300 || res.status >= 400 || opts.followRedirects === false) return res
    const location = res.headers.get('location')
    if (!location) return res
    const next = new URL(location, current).toString()
    const v = checkUrl(next, purpose, policy)
    if (!v.allowed) throw new NetBlockedError(next, `redirect: ${v.reason}`)
    current = next
  }
  throw new NetBlockedError(current, 'too many redirects')
}

/** Opens a websocket to a local service (ComfyUI progress). Loopback only. */
export function guardedWebSocket(url: string): WebSocket {
  const verdict = checkUrl(url, 'local-ai', policy)
  if (!verdict.allowed) {
    log.warn(`net-guard blocked websocket: ${verdict.reason}`)
    throw new NetBlockedError(url, verdict.reason)
  }
  // eslint-disable-next-line no-restricted-globals -- this is the guarded wrapper
  return new WebSocket(url)
}
