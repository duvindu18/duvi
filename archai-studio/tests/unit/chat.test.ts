import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatDone, ChatError } from '@shared/chat'
import { openDatabase } from '../../src/main/db/database'
import { ChatRepo } from '../../src/main/db/chat-repo'
import { ProjectsRepo } from '../../src/main/db/projects-repo'
import { CHAT_SYSTEM_PROMPT, ChatService, ContextTooSmall, fitHistory, threadTitle } from '../../src/main/features/chat'
import { setNetPolicy } from '../../src/main/net-guard'
import { ComfyClient } from '../../src/main/services/comfy'
import { GpuCoordinator } from '../../src/main/services/gpu'
import { OllamaClient } from '../../src/main/services/ollama'
import { startFakeOllama, type FakeOllamaOptions } from '../fakes/fake-ollama'
import { startFakeComfy } from '../fakes/fake-comfy'
import type { FakeServer } from '../fakes/http-fake'

const servers: FakeServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

function collect() {
  let text = ''
  let thinking = ''
  let resolve!: (v: ChatDone | ChatError) => void
  const finished = new Promise<ChatDone | ChatError>((r) => (resolve = r))
  return {
    sink: {
      chunk: (c: { content?: string; thinking?: string }) => {
        text += c.content ?? ''
        thinking += c.thinking ?? ''
      },
      done: (d: ChatDone) => resolve(d),
      error: (e: ChatError) => resolve(e)
    },
    finished,
    text: () => text,
    thinking: () => thinking
  }
}

async function setup(opts: FakeOllamaOptions & { down?: boolean } = {}, numCtx = 8192) {
  const fake = await startFakeOllama(opts)
  servers.push(fake)
  if (opts.down) await fake.close()
  const comfy = await startFakeComfy()
  servers.push(comfy)
  setNetPolicy({ loopbackPorts: [fake.port, comfy.port] })
  const db = openDatabase(':memory:')
  const projects = new ProjectsRepo(db)
  const chats = new ChatRepo(db)
  const project = projects.create('Kandy Courtyard House')
  const ollama = new OllamaClient(() => fake.url)
  const comfyClient = new ComfyClient(() => comfy.url)
  const gpu = new GpuCoordinator(() => true, ollama, comfyClient)
  const svc = new ChatService({ ollama, chats: () => chats, projects: () => projects, gpu, numCtx: () => numCtx, batchMs: 1 })
  return { fake, comfy, svc, chats, project, gpu }
}

describe('chat', () => {
  let env: Awaited<ReturnType<typeof setup>>

  describe('with Ollama running', () => {
    beforeEach(async () => {
      env = await setup({ thinking: ['Consider', ' the monsoon.'] })
    })

    it('streams a reply, saves both sides and the reasoning', async () => {
      const c = collect()
      const started = await env.svc.send({ projectId: env.project.id, threadId: null, text: 'Roof pitch for clay tiles in Kandy?', model: 'gpt-oss:20b' }, c.sink)
      const done = (await c.finished) as ChatDone
      expect(c.text()).toBe('Hello from fake Ollama.')
      expect(c.thinking()).toBe('Consider the monsoon.')
      expect(done.message.content).toBe('Hello from fake Ollama.')
      expect(done.message.thinking).toBe('Consider the monsoon.')
      const thread = env.chats.thread(started.threadId)!
      expect(thread.title).toBe('Roof pitch for clay tiles in Kandy?')
      expect(env.chats.messages(thread.id).map((m) => m.role)).toEqual(['user', 'assistant'])
    })

    it('sends the system prompt, context length and history to Ollama', async () => {
      const c1 = collect()
      const s = await env.svc.send({ projectId: env.project.id, threadId: null, text: 'First question', model: 'gpt-oss:20b' }, c1.sink)
      await c1.finished
      const c2 = collect()
      await env.svc.send({ projectId: env.project.id, threadId: s.threadId, text: 'Follow-up', model: 'gpt-oss:20b' }, c2.sink)
      await c2.finished
      const body = JSON.parse(env.fake.requests.filter((r) => r.path === '/api/chat').at(-1)!.body)
      expect(body.options.num_ctx).toBe(8192)
      expect(body.stream).toBe(true)
      expect(body.think).toBe('medium')
      expect(body.messages[0].role).toBe('system')
      expect(body.messages[0].content).toContain('Sri Lanka')
      expect(body.messages.slice(1).map((m: { content: string }) => m.content)).toEqual(['First question', 'Hello from fake Ollama.', 'Follow-up'])
    })

    it('explains a missing model in plain language', async () => {
      const c = collect()
      await env.svc.send({ projectId: env.project.id, threadId: null, text: 'Hi', model: 'qwen3:32b' }, c.sink)
      const e = (await c.finished) as ChatError
      expect(e.message).toContain('ollama pull qwen3:32b')
    })

    it('frees ComfyUI memory before chatting after image work', async () => {
      await env.gpu.beforeImages()
      const c = collect()
      await env.svc.send({ projectId: env.project.id, threadId: null, text: 'Hi', model: 'gpt-oss:20b' }, c.sink)
      await c.finished
      expect(env.comfy.requests.some((r) => r.path === '/free')).toBe(true)
      expect(env.gpu.current()).toBe('chat')
    })
  })

  it('stopping keeps what was written so far', async () => {
    env = await setup({ reply: Array.from({ length: 50 }, (_, i) => `w${i} `), tokenDelayMs: 20 })
    const c = collect()
    const s = await env.svc.send({ projectId: env.project.id, threadId: null, text: 'Long answer please', model: 'gpt-oss:20b' }, c.sink)
    await new Promise((r) => setTimeout(r, 150))
    expect(env.svc.cancel(s.streamId)).toBe(true)
    const done = (await c.finished) as ChatDone
    expect(done.message.meta?.stopped).toBe(true)
    expect(done.message.content.length).toBeGreaterThan(0)
    expect(done.message.content).not.toContain('w49')
  })

  it('says Ollama is not running when it is stopped', async () => {
    env = await setup({ down: true })
    const c = collect()
    await env.svc.send({ projectId: env.project.id, threadId: null, text: 'Hi', model: 'gpt-oss:20b' }, c.sink)
    const e = (await c.finished) as ChatError
    expect(e.message).toBe("Ollama isn't running. Start it from the Start menu, then try again.")
  })

  it('refuses a thread from another project', async () => {
    env = await setup()
    const other = env.chats.createThread(env.project.id, 't', 'gpt-oss:20b')
    await expect(env.svc.send({ projectId: 999, threadId: other.id, text: 'x', model: 'gpt-oss:20b' }, collect().sink)).rejects.toThrow()
  })
})

describe('history fitting', () => {
  const msg = (role: 'user' | 'assistant', n: number) => ({ role, content: 'x'.repeat(n) })

  it('keeps the newest messages that fit, plus the system prompt', () => {
    const h = [msg('user', 7000), msg('assistant', 7000), msg('user', 7000), msg('assistant', 7000), msg('user', 100)]
    const out = fitHistory('system', h, 8192)
    expect(out[0]!.role).toBe('system')
    expect(out.at(-1)!.content).toHaveLength(100)
    expect(out.length).toBeLessThan(h.length + 1)
    const tokens = out.reduce((n, m) => n + m.content.length / 3.5, 0)
    expect(tokens).toBeLessThan(8192 - 2048)
  })

  it('explains when one message is too long for the context length', () => {
    expect(() => fitHistory('s', [msg('user', 40_000)], 8192)).toThrow(ContextTooSmall)
    expect(() => fitHistory('s', [msg('user', 40_000)], 8192)).toThrow(/raise Context length/)
  })

  it('makes short thread titles', () => {
    expect(threadTitle('  Setback   rules\nfor Colombo  ')).toBe('Setback rules for Colombo')
    expect(threadTitle('a'.repeat(100))).toHaveLength(58)
  })

  it('the system prompt carries the practice context and verification rule', () => {
    expect(CHAT_SYSTEM_PROMPT).toContain('metric')
    expect(CHAT_SYSTEM_PROMPT).toContain('UDA')
    expect(CHAT_SYSTEM_PROMPT).toMatch(/Check this against the current source documents/)
    expect(CHAT_SYSTEM_PROMPT).toContain('UK / Sri Lankan English')
  })
})
