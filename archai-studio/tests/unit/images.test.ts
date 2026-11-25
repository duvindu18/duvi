import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyBindings,
  checkBindings,
  composePrompt,
  detectBindings,
  guessMode,
  parseApiWorkflow,
  sizeForImage,
  STYLE_PRESETS,
  WorkflowFormatError,
  type ImageDone,
  type ImageError,
  type ImageProgress
} from '@shared/images'
import { openDatabase } from '../../src/main/db/database'
import { ImagesRepo } from '../../src/main/db/images-repo'
import { ProjectsRepo } from '../../src/main/db/projects-repo'
import { BUILT_IN_WORKFLOWS, ImagesService, parseHelperReply } from '../../src/main/features/images'
import { setNetPolicy } from '../../src/main/net-guard'
import { ComfyClient, explainComfyError } from '../../src/main/services/comfy'
import { GpuCoordinator } from '../../src/main/services/gpu'
import { OllamaClient } from '../../src/main/services/ollama'
import { addPngText, pngSize, readPngText } from '../../src/main/services/png'
import { makePng, startFakeComfy, type FakeComfyOptions } from '../fakes/fake-comfy'
import { startFakeOllama } from '../fakes/fake-ollama'
import type { FakeServer } from '../fakes/http-fake'

const servers: FakeServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()))
})

describe('built-in workflow templates', () => {
  it('ships text, sketch and variation templates that pass their own checks', () => {
    const modes = BUILT_IN_WORKFLOWS.map((w) => w.mode)
    expect(modes).toEqual(expect.arrayContaining(['text', 'sketch', 'variation']))
    for (const w of BUILT_IN_WORKFLOWS) {
      expect(parseApiWorkflow(w.json)).toBeTruthy()
      expect(checkBindings(w.json, w.bindings, w.mode)).toEqual([])
    }
  })

  it('detects the same bindings automatically, as for an imported workflow', () => {
    const sketch = BUILT_IN_WORKFLOWS.find((w) => w.id === 'sdxl-sketch-controlnet')!
    const b = detectBindings(sketch.json)
    expect(b.positive).toEqual({ node: '6', input: 'text' })
    expect(b.negative).toEqual({ node: '7', input: 'text' })
    expect(b.seed).toEqual({ node: '3', input: 'seed' })
    expect(b.controlnet?.node).toBe('12')
    expect(b.image?.node).toBe('10')
    expect(guessMode(b)).toBe('sketch')
  })

  it('fills values into a copy without touching links or the original', () => {
    const t = BUILT_IN_WORKFLOWS.find((w) => w.id === 'sdxl-text')!
    const g = applyBindings(t.json, t.bindings, { positive: 'a courtyard house', negative: 'blur', seed: 42, width: 1344, height: 768, checkpoint: 'x.safetensors' })
    expect(g['6']!.inputs.text).toBe('a courtyard house')
    expect(g['3']!.inputs.seed).toBe(42)
    expect(g['5']!.inputs.width).toBe(1344)
    expect(g['4']!.inputs.ckpt_name).toBe('x.safetensors')
    expect(g['3']!.inputs.model).toEqual(['4', 0])
    expect(t.json['6']!.inputs.text).toBe('')
  })
})

describe('imported workflows', () => {
  it('explains how to export when given the editor format', () => {
    expect(() => parseApiWorkflow({ nodes: [], links: [] })).toThrow(/Export \(API\)/)
    expect(() => parseApiWorkflow([])).toThrow(WorkflowFormatError)
    expect(() => parseApiWorkflow({ '1': { class_type: 'KSampler' } })).toThrow(/API format/)
    expect(() => parseApiWorkflow({ '1': { class_type: 'KSampler', inputs: {} } })).toThrow(/Save Image/)
  })

  it('reports bindings that point nowhere', () => {
    const t = BUILT_IN_WORKFLOWS.find((w) => w.id === 'sdxl-text')!
    expect(checkBindings(t.json, { positive: { node: '99', input: 'text' } }, 'text')[0]).toMatch(/node 99/)
    expect(checkBindings(t.json, {}, 'variation')).toEqual(expect.arrayContaining([expect.stringMatching(/Load Image/)]))
  })
})

describe('prompts and sizes', () => {
  it('has the six requested style presets', () => {
    expect(STYLE_PRESETS.map((p) => p.name)).toEqual(['Tropical modern', 'Bawa-inspired courtyard', 'Brutalist', 'Scandinavian', 'Night exterior', 'Interior daylight'])
  })
  it('composes description, preset and quality words', () => {
    const c = composePrompt('a house in Galle', 'bawa-courtyard')
    expect(c.positive.startsWith('a house in Galle, courtyard house inspired by Geoffrey Bawa')).toBe(true)
    expect(c.negative).toContain('watermark')
  })
  it('keeps the aspect ratio of an input image at about 1 megapixel', () => {
    expect(sizeForImage(1920, 1080)).toEqual({ width: 1344, height: 768 })
    expect(sizeForImage(800, 800)).toEqual({ width: 1024, height: 1024 })
    expect(sizeForImage(0, 0)).toEqual({ width: 1024, height: 1024 })
  })
  it('reads the prompt helper reply, even with extra text', () => {
    expect(parseHelperReply('Sure: {"prompt":"a villa","negative":"blur"} done')).toEqual({ positive: 'a villa', negative: 'blur' })
    expect(parseHelperReply('no json')).toBeNull()
    expect(parseHelperReply('{"prompt":""}')).toBeNull()
  })
  it('explains a missing model file', () => {
    const msg = explainComfyError({
      error: { type: 'prompt_outputs_failed_validation' },
      node_errors: { '4': { class_type: 'CheckpointLoaderSimple', errors: [{ message: 'Value not in list', details: "ckpt_name: 'missing.safetensors' not in ['a.safetensors']" }] } }
    })
    expect(msg).toBe(`ComfyUI can't find the model file "missing.safetensors". Choose one that's installed under Advanced, or copy the file into ComfyUI's models folder and restart ComfyUI.`)
  })
})

describe('PNG metadata', () => {
  it('adds UTF-8 text without re-encoding, keeping ComfyUI chunks', () => {
    const png = makePng(10, 6, { prompt: '{"a":1}' })
    const out = addPngText(png, { parameters: 'Courtyard, 42 m², 35°', 'archai:seed': '7' })
    expect(pngSize(out)).toEqual({ width: 10, height: 6 })
    const t = readPngText(out)
    expect(t.prompt).toBe('{"a":1}')
    expect(t.parameters).toBe('Courtyard, 42 m², 35°')
    expect(t['archai:seed']).toBe('7')
  })
})

async function service(comfyOpts: FakeComfyOptions = {}) {
  const comfy = await startFakeComfy(comfyOpts)
  const ollama = await startFakeOllama({ reply: ['{"prompt": "tropical villa, laterite walls", "negative": "snow"}'] })
  servers.push(comfy, ollama)
  setNetPolicy({ loopbackPorts: [comfy.port, ollama.port] })
  const db = openDatabase(':memory:')
  const projects = new ProjectsRepo(db)
  const repo = new ImagesRepo(db)
  const project = projects.create('Galle Fort Hotel')
  const gallery = mkdtempSync(join(tmpdir(), 'archai-gallery-'))
  const comfyClient = new ComfyClient(() => comfy.url)
  const ollamaClient = new OllamaClient(() => ollama.url)
  const gpu = new GpuCoordinator(() => true, ollamaClient, comfyClient)
  const inputFile = join(gallery, 'sketch.png')
  writeFileSync(inputFile, makePng(1920, 1080))
  const svc = new ImagesService({
    comfy: comfyClient,
    ollama: ollamaClient,
    gpu,
    repo: () => repo,
    projects: () => projects,
    galleryDir: () => gallery,
    input: () => ({ path: inputFile, name: 'sketch.png', width: 1920, height: 1080 }),
    helperModel: () => 'gpt-oss:20b',
    numCtx: () => 8192,
    pollMs: 20
  })
  return { svc, comfy, ollama, repo, project, gpu }
}

function sink() {
  const progress: ImageProgress[] = []
  let resolve!: (v: ImageDone | ImageError) => void
  const finished = new Promise<ImageDone | ImageError>((r) => (resolve = r))
  return { progress, finished, s: { progress: (p: ImageProgress) => progress.push(p), done: resolve, error: resolve } }
}

const base = { positive: 'a courtyard house', negative: 'blur', seed: 1234, preset: null, description: 'courtyard house' }

describe('image jobs against a fake ComfyUI', () => {
  it('runs text to image with websocket progress and saves a PNG with metadata', async () => {
    const env = await service({ steps: 5 })
    const k = sink()
    await env.svc.generate({ ...base, projectId: env.project.id, workflowId: 'sdxl-text', size: 'wide', checkpoint: 'juggernautXL_v9.safetensors' }, k.s)
    const done = (await k.finished) as ImageDone
    expect(done.images).toHaveLength(1)
    expect(k.progress.filter((p) => p.stage === 'sampling').map((p) => p.value)).toEqual([1, 2, 3, 4, 5])
    const sent = env.comfy.prompts[0]!.prompt
    expect(sent['6']!.inputs.text).toBe('a courtyard house')
    expect(sent['3']!.inputs.seed).toBe(1234)
    expect(sent['5']!.inputs.width).toBe(1344)
    expect(sent['4']!.inputs.ckpt_name).toBe('juggernautXL_v9.safetensors')
    const row = env.repo.get(done.images[0]!.id)!
    const meta = readPngText(readFileSync(row.path))
    expect(meta['archai:seed']).toBe('1234')
    expect(meta['archai:model']).toBe('juggernautXL_v9.safetensors')
    expect(meta.parameters).toContain('Negative prompt: blur')
    expect(meta.prompt).toBe('{"fake":true}')
    expect(row.path).toContain('galle-fort-hotel')
    expect(done.images[0]!.url).toBe(`archai-img://gallery/${row.id}`)
  })

  it('uploads the sketch, sizes the latent to its aspect, and uses ControlNet', async () => {
    const env = await service()
    const k = sink()
    await env.svc.generate({ ...base, projectId: env.project.id, workflowId: 'sdxl-sketch-controlnet', input: { imageId: 1 }, strength: 0.6 }, k.s)
    expect('images' in (await k.finished)).toBe(true)
    expect(env.comfy.uploads).toHaveLength(1)
    const sent = env.comfy.prompts[0]!.prompt
    expect(sent['10']!.inputs.image).toBe(env.comfy.uploads[0])
    expect(sent['13']!.inputs.strength).toBe(0.6)
    expect([sent['5']!.inputs.width, sent['5']!.inputs.height]).toEqual([1344, 768])
  })

  it('unloads the chat model before rendering (GPU turn-taking)', async () => {
    const env = await service()
    await env.gpu.beforeChat('gpt-oss:20b')
    const k = sink()
    await env.svc.generate({ ...base, projectId: env.project.id, workflowId: 'sdxl-text' }, k.s)
    await k.finished
    const unload = env.ollama.requests.find((r) => r.path === '/api/generate')
    expect(JSON.parse(unload!.body)).toEqual({ model: 'gpt-oss:20b', keep_alive: 0 })
    expect(env.gpu.current()).toBe('images')
  })

  it('falls back to polling when the websocket is unavailable', async () => {
    const env = await service({ noWebsocket: true })
    const k = sink()
    await env.svc.generate({ ...base, projectId: env.project.id, workflowId: 'sdxl-text' }, k.s)
    expect('images' in (await k.finished)).toBe(true)
  })

  it('explains a missing model from ComfyUI validation', async () => {
    const env = await service({
      rejectWith: { error: { type: 'prompt_outputs_failed_validation' }, node_errors: { '4': { class_type: 'CheckpointLoaderSimple', errors: [{ message: 'Value not in list', details: "ckpt_name: 'x' not in []" }] } } }
    })
    const k = sink()
    await env.svc.generate({ ...base, projectId: env.project.id, workflowId: 'sdxl-text' }, k.s)
    expect(((await k.finished) as ImageError).message).toContain("can't find the model file")
  })

  it('reports errors during the run', async () => {
    const env = await service({ failAtRun: 'CUDA out of memory' })
    const k = sink()
    await env.svc.generate({ ...base, projectId: env.project.id, workflowId: 'sdxl-text' }, k.s)
    expect(((await k.finished) as ImageError).message).toBe('ComfyUI stopped at KSampler: CUDA out of memory')
  })

  it('can be stopped', async () => {
    const env = await service({ steps: 50, stepDelayMs: 30 })
    const k = sink()
    const { jobId } = await env.svc.generate({ ...base, projectId: env.project.id, workflowId: 'sdxl-text' }, k.s)
    await new Promise((r) => setTimeout(r, 200))
    env.svc.cancel(jobId)
    expect(((await k.finished) as ImageError).message).toBe('Stopped.')
    await expect.poll(() => env.comfy.interrupted).toBeGreaterThan(0)
  })

  it('says ComfyUI is not running when it is stopped', async () => {
    const env = await service()
    await env.comfy.close()
    servers.splice(servers.indexOf(env.comfy), 1)
    const k = sink()
    await env.svc.generate({ ...base, projectId: env.project.id, workflowId: 'sdxl-text' }, k.s)
    expect(((await k.finished) as ImageError).message).toMatch(/^ComfyUI isn't running/)
  })

  it('needs an input image for sketch mode', async () => {
    const env = await service()
    const svc2 = new ImagesService({ ...(env.svc as unknown as { d: ConstructorParameters<typeof ImagesService>[0] }).d, input: () => null })
    await expect(svc2.generate({ ...base, projectId: env.project.id, workflowId: 'sdxl-sketch-controlnet' }, sink().s)).rejects.toThrow(/Choose a sketch/)
  })

  it('prompt helper turns a description into prompt + negative', async () => {
    const env = await service()
    const r = await env.svc.promptHelp('small villa near Galle', 'tropical-modern', 'text')
    expect(r.positive).toBe('tropical villa, laterite walls')
    expect(r.negative).toContain('snow')
    expect(r.negative).toContain('watermark')
    const body = JSON.parse(env.ollama.requests.find((q) => q.path === '/api/chat')!.body)
    expect(body.messages[0].content).toContain('JSON')
  })
})
