/**
 * Network policy: the single source of truth for which hosts the app may
 * contact. Pure functions so they can be unit-tested.
 */

export type NetPurpose = 'local-ai' | 'github-import' | 'update-check'

export interface NetPolicy {
  /** Ports of local services (from Settings), e.g. Ollama 11434, ComfyUI 8188. */
  loopbackPorts: number[]
}

export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '[::1]', '::1'] as const

/** Hosts allowed only for the explicit, button-click purposes. */
export const PURPOSE_HOSTS: Record<Exclude<NetPurpose, 'local-ai'>, readonly string[]> = {
  'github-import': ['github.com', 'api.github.com', 'codeload.github.com'],
  'update-check': ['github.com', 'api.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']
}

export interface Verdict {
  allowed: boolean
  reason: string
}

export function checkUrl(rawUrl: string, purpose: NetPurpose, policy: NetPolicy): Verdict {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { allowed: false, reason: 'not a valid URL' }
  }
  if (url.username || url.password) return { allowed: false, reason: 'credentials in URL are not allowed' }

  const host = url.hostname.toLowerCase()

  if (purpose === 'local-ai') {
    if (url.protocol !== 'http:' && url.protocol !== 'ws:') {
      return { allowed: false, reason: `protocol ${url.protocol} not allowed for local services` }
    }
    if (!(LOOPBACK_HOSTS as readonly string[]).includes(host)) {
      return { allowed: false, reason: `host ${host} is not this computer (loopback only)` }
    }
    const port = Number(url.port || (url.protocol === 'http:' || url.protocol === 'ws:' ? 80 : 0))
    if (!policy.loopbackPorts.includes(port)) {
      return { allowed: false, reason: `port ${port} is not a configured local service` }
    }
    return { allowed: true, reason: 'local service' }
  }

  if (url.protocol !== 'https:') return { allowed: false, reason: 'only https is allowed for internet requests' }
  if (url.port && url.port !== '443') return { allowed: false, reason: 'non-standard port' }
  if (!PURPOSE_HOSTS[purpose].includes(host)) {
    return { allowed: false, reason: `host ${host} is not allowed for ${purpose}` }
  }
  return { allowed: true, reason: purpose }
}
