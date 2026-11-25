import { json, startFake, type FakeServer } from './http-fake'

export interface FakeOllamaOptions {
  port?: number
  models?: string[]
  /** Tokens streamed back by /api/chat. */
  reply?: string[]
  tokenDelayMs?: number
  /** Chooses the reply from the last user message (overrides `reply`). */
  replyFor?: (lastUserMessage: string, systemPrompt: string) => string[]
  /** Reasoning tokens streamed before the reply (like gpt-oss). */
  thinking?: string[]
}

/** Behaves like the parts of Ollama's API the app uses. */
export function startFakeOllama(opts: FakeOllamaOptions = {}): Promise<FakeServer> {
  const models = opts.models ?? ['gpt-oss:20b', 'nomic-embed-text:latest']
  const reply = opts.reply ?? ['Hello', ' from', ' fake', ' Ollama.']
  return startFake(
    {
      'GET /api/version': (_q, res) => json(res, 200, { version: '0.0.0-fake' }),
      'GET /api/tags': (_q, res) =>
        json(res, 200, {
          models: models.map((name) => ({ name, model: name, size: 13_000_000_000, details: { parameter_size: '20B', quantization_level: 'MXFP4' } }))
        }),
      'POST /api/chat': async (_q, res, body) => {
        const req = JSON.parse(body || '{}') as { model?: string; stream?: boolean; messages?: { role: string; content: string }[] }
        if (!req.model || !models.includes(req.model)) return json(res, 404, { error: `model "${req.model}" not found` })
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        for (const t of opts.thinking ?? []) {
          res.write(JSON.stringify({ model: req.model, message: { role: 'assistant', content: '', thinking: t }, done: false }) + '\n')
        }
        const msgs = req.messages ?? []
        const tokens = opts.replyFor
          ? opts.replyFor(msgs.filter((m) => m.role === 'user').at(-1)?.content ?? '', msgs.find((m) => m.role === 'system')?.content ?? '')
          : reply
        for (const t of tokens) {
          if (res.destroyed) return
          res.write(JSON.stringify({ model: req.model, message: { role: 'assistant', content: t }, done: false }) + '\n')
          if (opts.tokenDelayMs) await new Promise((r) => setTimeout(r, opts.tokenDelayMs))
        }
        res.end(JSON.stringify({ model: req.model, message: { role: 'assistant', content: '' }, done: true, eval_count: tokens.length }) + '\n')
      },
      'POST /api/generate': (_q, res) => json(res, 200, { done: true }),
      'POST /api/pull': async (_q, res, body) => {
        const req = JSON.parse(body || '{}') as { model?: string }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' })
        res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n')
        for (const [digest, total] of [['sha256:aaa', 1000], ['sha256:bbb', 200]] as const) {
          for (const done of [0, total / 2, total]) {
            res.write(JSON.stringify({ status: `pulling ${digest.slice(7)}`, digest, total, completed: done }) + '\n')
            await new Promise((r) => setTimeout(r, opts.tokenDelayMs ?? 5))
          }
        }
        res.write(JSON.stringify({ status: 'verifying sha256 digest' }) + '\n')
        res.end(JSON.stringify({ status: 'success' }) + '\n')
        if (req.model && !models.includes(req.model)) models.push(req.model)
      },
      'POST /api/embed': (_q, res, body) => {
        const req = JSON.parse(body || '{}') as { input?: string | string[] }
        const inputs = Array.isArray(req.input) ? req.input : [req.input ?? '']
        json(res, 200, { embeddings: inputs.map((s) => Array.from({ length: 8 }, (_, i) => ((s.length + i) % 7) / 7)) })
      }
    },
    opts.port
  )
}
