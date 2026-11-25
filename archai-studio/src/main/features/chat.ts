/**
 * Chat: builds the conversation for Ollama, streams the reply to the screen in
 * small batches, and saves both sides to the project's history.
 */
import { randomUUID } from 'node:crypto'
import chatPrompt from '../../../resources/prompts/chat.md?raw'
import type { ChatChunk, ChatDone, ChatError, ChatMessage, ChatSend, ChatStarted, MessageMeta } from '@shared/chat'
import type { ChatRepo } from '../db/chat-repo'
import type { ProjectsRepo } from '../db/projects-repo'
import { log } from '../log'
import type { GpuCoordinator } from '../services/gpu'
import { OllamaError, type OllamaClient, type OllamaMessage } from '../services/ollama'

export const CHAT_SYSTEM_PROMPT = chatPrompt

export interface ChatSink {
  chunk(c: ChatChunk): void
  done(d: ChatDone): void
  error(e: ChatError): void
}

/** Rough token estimate. Good enough to keep history inside the context window. */
export const estimateTokens = (s: string): number => Math.ceil(s.length / 3.5) + 4

export class ContextTooSmall extends Error {}

/**
 * Keeps the system prompt and the newest messages that fit in numCtx,
 * leaving room for the reply. The new message is always kept.
 */
export function fitHistory(system: string, history: { role: 'user' | 'assistant'; content: string }[], numCtx: number): OllamaMessage[] {
  const replyBudget = Math.min(2048, Math.floor(numCtx / 4))
  let budget = numCtx - replyBudget - estimateTokens(system)
  const newest = history.at(-1)
  if (!newest) return [{ role: 'system', content: system }]
  const need = estimateTokens(newest.content)
  if (need > budget) {
    throw new ContextTooSmall(
      `That message is about ${need.toLocaleString('en-GB')} tokens, more than the model can read at the current context length (${numCtx.toLocaleString('en-GB')}). Shorten it, or raise Context length in Settings.`
    )
  }
  const kept: OllamaMessage[] = []
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!
    const t = estimateTokens(m.content)
    if (t > budget) break
    budget -= t
    kept.unshift({ role: m.role, content: m.content })
  }
  return [{ role: 'system', content: system }, ...kept]
}

export function threadTitle(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > 60 ? `${one.slice(0, 57).trimEnd()}…` : one
}

interface ActiveStream {
  controller: AbortController
}

export class ChatService {
  private readonly active = new Map<string, ActiveStream>()

  constructor(
    private readonly deps: {
      ollama: OllamaClient
      chats: () => ChatRepo
      projects: () => ProjectsRepo
      gpu: GpuCoordinator
      numCtx: () => number
      /** Builds the system prompt; skills are added here in M6. */
      systemPrompt?: (base: string, userText: string) => Promise<{ prompt: string; skills: string[] }>
      kind?: string
      base?: string
      batchMs?: number
    }
  ) {}

  async send(req: ChatSend, sink: ChatSink): Promise<ChatStarted> {
    const chats = this.deps.chats()
    if (!this.deps.projects().get(req.projectId)) throw new Error('That project no longer exists.')
    let thread = req.threadId ? chats.thread(req.threadId) : null
    if (req.threadId && (!thread || thread.projectId !== req.projectId)) throw new Error('That chat no longer exists.')
    const history = thread ? chats.messages(thread.id).map((m) => ({ role: m.role, content: m.content })) : []
    history.push({ role: 'user', content: req.text })

    const base = this.deps.base ?? CHAT_SYSTEM_PROMPT
    const sys = this.deps.systemPrompt ? await this.deps.systemPrompt(base, req.text) : { prompt: base, skills: [] }
    const numCtx = this.deps.numCtx()
    const messages = fitHistory(sys.prompt, history, numCtx) // throws before anything is saved

    thread ??= chats.createThread(req.projectId, threadTitle(req.text), req.model, this.deps.kind ?? 'chat')
    chats.touch(thread.id, req.model)
    const userMessage = chats.addMessage(thread.id, 'user', req.text)

    const streamId = randomUUID()
    const controller = new AbortController()
    this.active.set(streamId, { controller })
    void this.run(streamId, thread.id, req.model, messages, numCtx, sys.skills, controller, sink)
    return { streamId, threadId: thread.id, userMessage }
  }

  cancel(streamId: string): boolean {
    const s = this.active.get(streamId)
    if (!s) return false
    s.controller.abort()
    return true
  }

  private async run(
    streamId: string,
    threadId: number,
    model: string,
    messages: OllamaMessage[],
    numCtx: number,
    skills: string[],
    controller: AbortController,
    sink: ChatSink
  ): Promise<void> {
    let content = ''
    let thinking = ''
    let pendingC = ''
    let pendingT = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const flush = () => {
      timer = null
      if (pendingC || pendingT) sink.chunk({ streamId, ...(pendingC && { content: pendingC }), ...(pendingT && { thinking: pendingT }) })
      pendingC = ''
      pendingT = ''
    }
    const meta: MessageMeta = { model, ...(skills.length && { skills }) }
    const started = Date.now()
    try {
      await this.deps.gpu.beforeChat(model)
      for await (const c of this.deps.ollama.chat({
        model,
        messages,
        numCtx,
        signal: controller.signal,
        ...(model.startsWith('gpt-oss') && { think: 'medium' as const })
      })) {
        const dc = c.message?.content ?? ''
        const dt = c.message?.thinking ?? ''
        content += dc
        thinking += dt
        pendingC += dc
        pendingT += dt
        if (!timer && (pendingC || pendingT)) timer = setTimeout(flush, this.deps.batchMs ?? 40)
        if (c.done) {
          meta.evalCount = c.eval_count
          meta.durationMs = c.total_duration ? Math.round(c.total_duration / 1e6) : Date.now() - started
        }
      }
      if (timer) clearTimeout(timer)
      flush()
      const message = this.deps.chats().addMessage(threadId, 'assistant', content, thinking || null, meta)
      sink.done({ streamId, message })
    } catch (e) {
      if (timer) clearTimeout(timer)
      flush()
      if (controller.signal.aborted) {
        const message: ChatMessage = this.deps.chats().addMessage(threadId, 'assistant', content, thinking || null, { ...meta, stopped: true })
        sink.done({ streamId, message })
      } else {
        const msg = e instanceof OllamaError ? e.message : 'The reply stopped unexpectedly. Check that Ollama is running, then try again.'
        log.error('chat stream failed', e)
        sink.error({ streamId, message: msg })
      }
    } finally {
      this.active.delete(streamId)
    }
  }
}
