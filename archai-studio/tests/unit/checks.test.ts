import { afterEach, describe, expect, it } from 'vitest'
import { hasModel, GB } from '@shared/checks'
import { defaultSettings, type Settings } from '@shared/settings'
import { detectGpu, freeBytesFor, parseNvidiaSmi, runChecks, type CheckDeps } from '../../src/main/services/checks'
import { ComfyClient } from '../../src/main/services/comfy'
import { OllamaClient } from '../../src/main/services/ollama'
import { setNetPolicy } from '../../src/main/net-guard'
import { startFakeOllama } from '../fakes/fake-ollama'
import { startFakeComfy } from '../fakes/fake-comfy'
import type { FakeServer } from '../fakes/http-fake'

const servers: FakeServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

/** A port with nothing listening, like a stopped Ollama. */
const DEAD = 'http://127.0.0.1:9'

function setup(ollama: string, comfy: string, over: Partial<CheckDeps> = {}): { s: Settings; deps: CheckDeps } {
  const s = { ...defaultSettings('/tmp'), endpoints: { ollama, comfy } }
  setNetPolicy({ loopbackPorts: [ollama, comfy].map((u) => Number(new URL(u).port)) })
  const deps: CheckDeps = {
    ollama: new OllamaClient(() => s.endpoints.ollama),
    comfy: new ComfyClient(() => s.endpoints.comfy),
    nvidiaSmi: async () => 'NVIDIA GeForce RTX 5080, 16303\n',
    electronGpus: async () => [],
    freeBytes: async () => 400 * GB,
    ...over
  }
  return { s, deps }
}

const byId = (r: Awaited<ReturnType<typeof runChecks>>, id: string) => r.find((x) => x.id === id)!

describe('first-run checks', () => {
  it('all green when everything is running', async () => {
    const o = await startFakeOllama()
    const c = await startFakeComfy()
    servers.push(o, c)
    const { s, deps } = setup(o.url, c.url)
    const r = await runChecks(s, deps)
    expect(r.map((x) => [x.id, x.status])).toEqual([
      ['ollama', 'ok'],
      ['model', 'ok'],
      ['comfy', 'ok'],
      ['gpu', 'ok'],
      ['disk', 'ok']
    ])
    expect(byId(r, 'gpu').title).toBe('NVIDIA GeForce RTX 5080')
    expect(byId(r, 'gpu').detail).toContain('16 GB')
  })

  it('reports a stopped Ollama with a fix and a command to copy', async () => {
    const c = await startFakeComfy()
    servers.push(c)
    const { s, deps } = setup(DEAD, c.url)
    const r = await runChecks(s, deps)
    const o = byId(r, 'ollama')
    expect(o.status).toBe('fail')
    expect(o.title).toBe("Ollama isn't running")
    expect(o.fix?.command).toBe('ollama serve')
    expect(o.fix?.link?.url).toMatch(/^https:\/\/ollama\.com/)
    expect(byId(r, 'model').status).toBe('fail')
    expect(byId(r, 'comfy').status).toBe('ok')
  })

  it('reports a stopped ComfyUI, and says chat still works', async () => {
    const o = await startFakeOllama()
    servers.push(o)
    const { s, deps } = setup(o.url, DEAD)
    const comfy = byId(await runChecks(s, deps), 'comfy')
    expect(comfy.status).toBe('fail')
    expect(comfy.detail).toContain('Chat and scripts still work')
    expect(comfy.fix?.text).toContain('CUDA 12.8')
  })

  it('tells you how to pull a missing model, never pulls it itself', async () => {
    const o = await startFakeOllama({ models: ['llama3.2:3b'] })
    servers.push(o)
    const { s, deps } = setup(o.url, DEAD)
    const m = byId(await runChecks(s, deps), 'model')
    expect(m.status).toBe('fail')
    expect(m.fix?.command).toBe('ollama pull gpt-oss:20b')
    expect(m.detail).toContain('llama3.2:3b')
    expect(o.requests.some((q) => q.path === '/api/pull')).toBe(false)
  })

  it('warns on low disk space and fails on very low', async () => {
    const o = await startFakeOllama()
    servers.push(o)
    let { s, deps } = setup(o.url, DEAD, { freeBytes: async () => 12 * GB })
    expect(byId(await runChecks(s, deps), 'disk').status).toBe('warn')
    ;({ s, deps } = setup(o.url, DEAD, { freeBytes: async () => 2 * GB }))
    expect(byId(await runChecks(s, deps), 'disk').status).toBe('fail')
  })

  it('finds the GPU from ComfyUI or Electron when nvidia-smi is missing', async () => {
    const { deps } = setup(DEAD, DEAD, { nvidiaSmi: async () => null })
    const g = await detectGpu(deps, { devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 5080 : cudaMallocAsync', type: 'cuda', vram_total: 17_094_000_000 }] })
    expect(g).toEqual({ name: 'NVIDIA GeForce RTX 5080', vramGb: 16, source: 'comfyui' })
    const e = await detectGpu({ ...deps, electronGpus: async () => [{ vendorId: 0x10de, name: 'NVIDIA GeForce RTX 5080' }] }, null)
    expect(e?.source).toBe('electron')
    expect(await detectGpu({ ...deps, electronGpus: async () => [{ vendorId: 0x8086 }] }, null)).toBeNull()
  })

  it('warns when no NVIDIA GPU is present', async () => {
    const { s, deps } = setup(DEAD, DEAD, { nvidiaSmi: async () => null })
    const gpu = byId(await runChecks(s, deps), 'gpu')
    expect(gpu.status).toBe('warn')
    expect(gpu.fix?.link?.url).toContain('nvidia.com')
  })

  it('parses nvidia-smi output', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 5080, 16303\r\n')).toEqual({ name: 'NVIDIA GeForce RTX 5080', vramGb: 16, source: 'nvidia-smi' })
    expect(parseNvidiaSmi('')).toBeNull()
  })

  it('matches model names the way Ollama does', () => {
    expect(hasModel(['gpt-oss:20b'], 'gpt-oss:20b')).toBe(true)
    expect(hasModel(['nomic-embed-text:latest'], 'nomic-embed-text')).toBe(true)
    expect(hasModel(['gpt-oss:120b'], 'gpt-oss:20b')).toBe(false)
    expect(hasModel(['GPT-OSS:20B'], 'gpt-oss:20b')).toBe(true)
  })

  it('reads free space for a folder that does not exist yet', async () => {
    expect(await freeBytesFor('/tmp/does/not/exist/yet')).toBeGreaterThan(0)
  })
})
