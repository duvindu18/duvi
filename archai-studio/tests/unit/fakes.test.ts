import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startFakeOllama } from '../fakes/fake-ollama'
import { startFakeComfy } from '../fakes/fake-comfy'
import type { FakeServer } from '../fakes/http-fake'

describe('fake local services (used by all later tests)', () => {
  let ollama: FakeServer
  let comfy: FakeServer
  beforeAll(async () => {
    ollama = await startFakeOllama()
    comfy = await startFakeComfy()
  })
  afterAll(async () => {
    await ollama.close()
    await comfy.close()
  })

  it('fake Ollama lists models and streams NDJSON', async () => {
    const tags = (await (await fetch(`${ollama.url}/api/tags`)).json()) as { models: { name: string }[] }
    expect(tags.models.map((m) => m.name)).toContain('gpt-oss:20b')
    const res = await fetch(`${ollama.url}/api/chat`, { method: 'POST', body: JSON.stringify({ model: 'gpt-oss:20b', messages: [] }) })
    const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l) as { done: boolean; message: { content: string } })
    expect(lines.at(-1)?.done).toBe(true)
    expect(lines.map((l) => l.message.content).join('')).toBe('Hello from fake Ollama.')
  })

  it('fake ComfyUI reports a GPU', async () => {
    const stats = (await (await fetch(`${comfy.url}/system_stats`)).json()) as { devices: { name: string }[] }
    expect(stats.devices[0]?.name).toContain('RTX 5080')
  })
})
