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
}
