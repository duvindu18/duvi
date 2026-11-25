/** Ollama HTTP client (loopback only, via the network guard). */
import { guardedFetch } from '../net-guard'

export interface OllamaModel {
  name: string
  size?: number
  details?: { parameter_size?: string; quantization_level?: string; family?: string }
}

export class OllamaClient {
  constructor(private readonly base: () => string) {}

  private async getJson<T>(path: string, timeoutMs = 3000): Promise<T> {
    const res = await guardedFetch(`${this.base()}${path}`, 'local-ai', { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`Ollama replied ${res.status}`)
    return (await res.json()) as T
  }

  async version(timeoutMs?: number): Promise<string> {
    return (await this.getJson<{ version: string }>('/api/version', timeoutMs)).version
  }

  async tags(timeoutMs?: number): Promise<OllamaModel[]> {
    return (await this.getJson<{ models?: OllamaModel[] }>('/api/tags', timeoutMs)).models ?? []
  }
}
