/** ComfyUI HTTP client (loopback only, via the network guard). Image jobs arrive in M5. */
import { guardedFetch } from '../net-guard'

export interface ComfyDevice {
  name: string
  type: string
  vram_total?: number
  vram_free?: number
}

export interface ComfySystemStats {
  system?: { comfyui_version?: string; python_version?: string; pytorch_version?: string }
  devices?: ComfyDevice[]
}

export class ComfyClient {
  constructor(private readonly base: () => string) {}

  async systemStats(timeoutMs = 3000): Promise<ComfySystemStats> {
    const res = await guardedFetch(`${this.base()}/system_stats`, 'local-ai', { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`ComfyUI replied ${res.status}`)
    return (await res.json()) as ComfySystemStats
  }

  /** Releases ComfyUI's models from video memory. */
  async free(): Promise<void> {
    await guardedFetch(`${this.base()}/free`, 'local-ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(5000)
    })
  }
}
