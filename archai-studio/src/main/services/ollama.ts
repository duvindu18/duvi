/** Ollama HTTP client (loopback only, via the network guard). */
import { guardedFetch } from '../net-guard'
import { readNdjson } from './ndjson'

export interface OllamaModel {
  name: string
  size?: number
  details?: { parameter_size?: string; quantization_level?: string; family?: string }
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatChunkRaw {
  message?: { role: string; content?: string; thinking?: string }
  done: boolean
  error?: string
  eval_count?: number
  eval_duration?: number
  total_duration?: number
}

export interface ChatRequest {
  model: string
  messages: OllamaMessage[]
  numCtx: number
  /** gpt-oss reasoning effort; other models ignore it. */
  think?: 'low' | 'medium' | 'high' | boolean
  signal?: AbortSignal
  /** Unload the model straight after (used for GPU turn-taking). */
  keepAlive?: string | number
}

/** A readable message for errors Ollama returns. */
export class OllamaError extends Error {}

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

  /** Streams a chat reply. Yields chunks until done; throws OllamaError with a plain message on failure. */
  async *chat(req: ChatRequest): AsyncGenerator<ChatChunkRaw> {
    let res: Response
    try {
      res = await guardedFetch(`${this.base()}/api/chat`, 'local-ai', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: req.signal,
        body: JSON.stringify({
          model: req.model,
          messages: req.messages,
          stream: true,
          options: { num_ctx: req.numCtx },
          ...(req.think !== undefined && { think: req.think }),
          ...(req.keepAlive !== undefined && { keep_alive: req.keepAlive })
        })
      })
    } catch (e) {
      if (req.signal?.aborted) throw e
      throw new OllamaError("Ollama isn't running. Start it from the Start menu, then try again.")
    }
    if (!res.ok || !res.body) {
      let detail = ''
      try {
        detail = ((await res.json()) as { error?: string }).error ?? ''
      } catch {
        /* no body */
      }
      if (res.status === 404 && /not found/i.test(detail)) {
        throw new OllamaError(`The model "${req.model}" isn't downloaded. In PowerShell run: ollama pull ${req.model}`)
      }
      throw new OllamaError(`Ollama couldn't answer (${res.status}${detail ? `: ${detail}` : ''}).`)
    }
    for await (const chunk of readNdjson<ChatChunkRaw>(res.body)) {
      if (chunk.error) throw new OllamaError(`Ollama stopped with an error: ${chunk.error}`)
      yield chunk
      if (chunk.done) return
    }
  }

  /**
   * Downloads a model through Ollama (Ollama fetches it from its own registry).
   * Reports total bytes across all layers.
   */
  async pull(model: string, onProgress: (bytes: number, total: number, status: string) => void, signal?: AbortSignal): Promise<void> {
    const res = await guardedFetch(`${this.base()}/api/pull`, 'local-ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal
    }).catch(() => {
      throw new OllamaError("Ollama isn't running, so the model can't be downloaded. Start Ollama, then try again.")
    })
    if (!res.ok || !res.body) throw new OllamaError(`Ollama couldn't start the download (${res.status}).`)
    const layers = new Map<string, { total: number; completed: number }>()
    for await (const c of readNdjson<{ status?: string; digest?: string; total?: number; completed?: number; error?: string }>(res.body)) {
      if (c.error) throw new OllamaError(`Ollama couldn't download ${model}: ${c.error}`)
      if (c.digest && c.total) layers.set(c.digest, { total: c.total, completed: c.completed ?? 0 })
      let total = 0
      let done = 0
      for (const l of layers.values()) {
        total += l.total
        done += l.completed
      }
      onProgress(done, total, c.status ?? '')
      if (c.status === 'success') return
    }
    throw new OllamaError(`The download of ${model} stopped before it finished. Try again to resume it.`)
  }

  /** Asks Ollama to unload a model from video memory now. */
  async unload(model: string): Promise<void> {
    await guardedFetch(`${this.base()}/api/generate`, 'local-ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(5000)
    })
  }
}
