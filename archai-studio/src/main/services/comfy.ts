/** ComfyUI HTTP + websocket client (loopback only, via the network guard). */
import type { ApiWorkflow, ComfyModels } from '@shared/images'
import { guardedFetch, guardedWebSocket } from '../net-guard'

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

export interface ComfyImageRef {
  filename: string
  subfolder: string
  type: string
}

export interface ComfyHistoryEntry {
  outputs?: Record<string, { images?: ComfyImageRef[] }>
  status?: { status_str?: string; completed?: boolean; messages?: [string, Record<string, unknown>][] }
}

/** A ComfyUI problem in plain language. */
export class ComfyError extends Error {}

const DOWN = "ComfyUI isn't running. Start it, then try again. Chat and scripts still work without it."

/** Turns ComfyUI's validation errors into something an architect can act on. */
export function explainComfyError(body: unknown): string {
  const b = body as { error?: { message?: string; type?: string }; node_errors?: Record<string, { class_type?: string; errors?: { message?: string; details?: string }[] }> }
  const details = Object.values(b?.node_errors ?? {}).flatMap((n) => (n.errors ?? []).map((e) => ({ cls: n.class_type ?? '', msg: `${e.message ?? ''} ${e.details ?? ''}` })))
  const missing = details.find((d) => /not in list|not in \[/i.test(d.msg))
  if (missing) {
    const m = /(ckpt_name|control_net_name|lora_name|vae_name|unet_name|clip_name|image)\s*:\s*'([^']*)'/.exec(missing.msg)
    const what = m?.[1] === 'control_net_name' ? 'ControlNet model' : m?.[1] === 'image' ? 'input image' : m?.[1] ? 'model file' : 'file'
    return `ComfyUI can't find the ${what}${m?.[2] ? ` "${m[2]}"` : ''}. Choose one that's installed under Advanced, or copy the file into ComfyUI's models folder and restart ComfyUI.`
  }
  const unknownNode = /Cannot execute because node (\S+) does not exist|class_type.*not found|invalid_prompt.*node/i.exec(JSON.stringify(b))
  if (unknownNode || b?.error?.type === 'invalid_prompt') {
    return `ComfyUI doesn't recognise a node in this workflow${unknownNode?.[1] ? ` (${unknownNode[1]})` : ''}. Install the missing custom node in ComfyUI, or choose another workflow. ${b?.error?.message ?? ''}`.trim()
  }
  const first = details[0]
  return `ComfyUI refused the job: ${first ? `${first.cls}: ${first.msg.trim()}` : (b?.error?.message ?? 'unknown error')}`
}

export class ComfyClient {
  constructor(private readonly base: () => string) {}

  private async req(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<Response> {
    try {
      return await guardedFetch(`${this.base()}${path}`, 'local-ai', { signal: AbortSignal.timeout(timeoutMs), ...init })
    } catch (e) {
      if (e instanceof Error && e.name === 'NetBlockedError') throw e
      throw new ComfyError(DOWN)
    }
  }

  async systemStats(timeoutMs = 3000): Promise<ComfySystemStats> {
    const res = await guardedFetch(`${this.base()}/system_stats`, 'local-ai', { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`ComfyUI replied ${res.status}`)
    return (await res.json()) as ComfySystemStats
  }

  /** Model files ComfyUI can see. */
  async models(): Promise<ComfyModels> {
    const list = async (node: string, input: string): Promise<string[]> => {
      const res = await this.req(`/object_info/${node}`)
      if (!res.ok) return []
      const info = (await res.json()) as Record<string, { input?: { required?: Record<string, unknown[]> } }>
      const v = info[node]?.input?.required?.[input]?.[0]
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
    }
    const [checkpoints, controlnets] = await Promise.all([list('CheckpointLoaderSimple', 'ckpt_name'), list('ControlNetLoader', 'control_net_name')])
    return { checkpoints, controlnets }
  }

  async uploadImage(bytes: Buffer, filename: string): Promise<string> {
    const form = new FormData()
    form.append('image', new Blob([new Uint8Array(bytes)]), filename)
    form.append('type', 'input')
    form.append('overwrite', 'true')
    const res = await this.req('/upload/image', { method: 'POST', body: form }, 60_000)
    if (!res.ok) throw new ComfyError(`ComfyUI couldn't take the input image (${res.status}).`)
    const j = (await res.json()) as { name: string; subfolder?: string }
    return j.subfolder ? `${j.subfolder}/${j.name}` : j.name
  }

  async queue(prompt: ApiWorkflow, clientId: string): Promise<string> {
    const res = await this.req('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, client_id: clientId }) })
    const body = (await res.json().catch(() => ({}))) as { prompt_id?: string }
    if (!res.ok || !body.prompt_id) throw new ComfyError(explainComfyError(body))
    return body.prompt_id
  }

  async history(promptId: string): Promise<ComfyHistoryEntry | null> {
    const res = await this.req(`/history/${encodeURIComponent(promptId)}`)
    if (!res.ok) return null
    const j = (await res.json()) as Record<string, ComfyHistoryEntry>
    return j[promptId] ?? null
  }

  async view(ref: ComfyImageRef): Promise<Buffer> {
    const q = new URLSearchParams({ filename: ref.filename, subfolder: ref.subfolder, type: ref.type })
    const res = await this.req(`/view?${q}`, {}, 60_000)
    if (!res.ok) throw new ComfyError(`ComfyUI didn't return the image (${res.status}).`)
    return Buffer.from(await res.arrayBuffer())
  }

  async interrupt(promptId: string): Promise<void> {
    await this.req('/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [promptId] }) }).catch(() => undefined)
    await this.req('/interrupt', { method: 'POST' }).catch(() => undefined)
  }

  /** Releases ComfyUI's models from video memory. */
  async free(): Promise<void> {
    await this.req('/free', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }) }, 5000)
  }

  /** Opens the progress websocket. Resolves once connected, or null if it can't connect (we then poll). */
  openSocket(clientId: string, timeoutMs = 4000): Promise<WebSocket | null> {
    const url = `${this.base().replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`
    return new Promise((resolve) => {
      let ws: WebSocket
      try {
        ws = guardedWebSocket(url)
      } catch {
        resolve(null)
        return
      }
      const t = setTimeout(() => {
        ws.close()
        resolve(null)
      }, timeoutMs)
      ws.addEventListener('open', () => {
        clearTimeout(t)
        resolve(ws)
      })
      ws.addEventListener('error', () => {
        clearTimeout(t)
        resolve(null)
      })
    })
  }
}
