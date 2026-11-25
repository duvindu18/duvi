/**
 * Visual Studio: fills your prompt into a ComfyUI workflow, queues it, follows
 * progress over ComfyUI's websocket, and saves the results into the project's
 * gallery as PNGs with the prompt, seed and model inside.
 */
import { randomInt, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import helperPrompt from '../../../resources/prompts/image-helper.md?raw'
import {
  applyBindings,
  checkBindings,
  composePrompt,
  SIZES,
  sizeForImage,
  type ApiWorkflow,
  type Bindings,
  type GalleryImage,
  type GenerateRequest,
  type ImageDone,
  type ImageError,
  type ImageMode,
  type ImageProgress,
  type WorkflowInfo
} from '@shared/images'
import type { ImageRow, ImagesRepo } from '../db/images-repo'
import type { ProjectsRepo } from '../db/projects-repo'
import { log } from '../log'
import { ComfyError, type ComfyClient, type ComfyHistoryEntry } from '../services/comfy'
import type { GpuCoordinator } from '../services/gpu'
import type { OllamaClient } from '../services/ollama'
import { addPngText, pngSize } from '../services/png'

export const IMAGE_HELPER_PROMPT = helperPrompt

/* Built-in templates from resources/workflows (bundled at build time). */
const files = import.meta.glob('../../../resources/workflows/*.json', { eager: true, import: 'default' }) as Record<string, unknown>

export const BUILT_IN_WORKFLOWS: (WorkflowInfo & { json: ApiWorkflow })[] = Object.entries(files)
  .filter(([p]) => p.endsWith('.meta.json'))
  .map(([p, meta]) => {
    const id = basename(p, '.meta.json')
    const m = meta as { name: string; mode: ImageMode; description: string; bindings: Bindings }
    const json = files[p.replace('.meta.json', '.json')] as ApiWorkflow
    return { id, name: m.name, mode: m.mode, description: m.description, builtIn: true, bindings: m.bindings, json }
  })
  .sort((a, b) => a.id.localeCompare(b.id))

export interface ImageSink {
  progress(p: ImageProgress): void
  done(d: ImageDone): void
  error(e: ImageError): void
}

export interface InputImage {
  path: string
  name: string
  width: number
  height: number
}

export interface ImagesDeps {
  comfy: ComfyClient
  ollama: OllamaClient
  gpu: GpuCoordinator
  repo: () => ImagesRepo
  projects: () => ProjectsRepo
  galleryDir: () => string
  /** Resolves an input token or gallery image to a file. */
  input: (ref: NonNullable<GenerateRequest['input']>) => InputImage | null
  helperModel: () => string
  numCtx: () => number
  /** Ollama/ComfyUI progress socket timeout in tests. */
  pollMs?: number
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project'

export function toGallery(r: ImageRow): GalleryImage {
  return {
    id: r.id,
    projectId: r.project_id,
    url: `archai-img://gallery/${r.id}`,
    width: r.width,
    height: r.height,
    positive: r.positive,
    negative: r.negative,
    seed: r.seed,
    model: r.model,
    workflow: r.workflow,
    mode: r.mode,
    description: r.description,
    createdAt: r.created_at
  }
}

/** Pulls {"prompt","negative"} out of a model reply, tolerating extra text around it. */
export function parseHelperReply(reply: string): { positive: string; negative: string } | null {
  const m = /\{[\s\S]*\}/.exec(reply)
  if (!m) return null
  try {
    const j = JSON.parse(m[0]) as { prompt?: unknown; negative?: unknown }
    if (typeof j.prompt !== 'string' || !j.prompt.trim()) return null
    return { positive: j.prompt.trim(), negative: typeof j.negative === 'string' ? j.negative.trim() : '' }
  } catch {
    return null
  }
}

export class ImagesService {
  private readonly jobs = new Map<string, { promptId: string | null; cancelled: boolean; ws: WebSocket | null }>()

  constructor(private readonly d: ImagesDeps) {}

  workflows(): (WorkflowInfo & { json: ApiWorkflow })[] {
    return [...BUILT_IN_WORKFLOWS, ...this.d.repo().workflows()]
  }

  workflow(id: string): (WorkflowInfo & { json: ApiWorkflow }) | null {
    return this.workflows().find((w) => w.id === id) ?? null
  }

  /** gpt-oss turns a short description into a full prompt + negative prompt. */
  async promptHelp(description: string, preset: string | null, mode: ImageMode): Promise<{ positive: string; negative: string }> {
    const fallback = composePrompt(description, preset)
    const styleLine = preset ? `Style: ${preset.replace(/-/g, ' ')}.` : ''
    const model = this.d.helperModel()
    await this.d.gpu.beforeChat(model)
    let text = ''
    for await (const c of this.d.ollama.chat({
      model,
      numCtx: Math.min(this.d.numCtx(), 8192),
      think: model.startsWith('gpt-oss') ? 'low' : undefined,
      messages: [
        { role: 'system', content: IMAGE_HELPER_PROMPT },
        { role: 'user', content: `Mode: ${mode}. ${styleLine}\nDescription: ${description.trim()}` }
      ]
    })) {
      text += c.message?.content ?? ''
    }
    const parsed = parseHelperReply(text)
    if (!parsed) {
      log.warn('prompt helper reply was not JSON; using the preset prompt')
      return fallback
    }
    // Keep the preset's negatives and the base negatives as well.
    const negative = [parsed.negative, fallback.negative].filter(Boolean).join(', ')
    return { positive: parsed.positive, negative }
  }

  async generate(req: GenerateRequest, sink: ImageSink): Promise<{ jobId: string }> {
    if (!this.d.projects().get(req.projectId)) throw new Error('That project no longer exists.')
    const wf = this.workflow(req.workflowId)
    if (!wf) throw new Error('That workflow is no longer available.')
    const input = req.input ? this.d.input(req.input) : null
    if (wf.mode !== 'text' && !input) throw new Error(wf.mode === 'sketch' ? 'Choose a sketch or massing screenshot first.' : 'Choose an image to vary first.')
    const problems = checkBindings(wf.json, wf.bindings, wf.mode)
    if (problems.length) throw new Error(problems[0])

    const jobId = randomUUID()
    this.jobs.set(jobId, { promptId: null, cancelled: false, ws: null })
    void this.run(jobId, req, wf, input, sink)
    return { jobId }
  }

  cancel(jobId: string): boolean {
    const j = this.jobs.get(jobId)
    if (!j) return false
    j.cancelled = true
    if (j.promptId) void this.d.comfy.interrupt(j.promptId)
    j.ws?.close()
    return true
  }

  private async run(jobId: string, req: GenerateRequest, wf: WorkflowInfo & { json: ApiWorkflow }, input: InputImage | null, sink: ImageSink): Promise<void> {
    const job = this.jobs.get(jobId)!
    const seed = req.seed ?? randomInt(0, 2 ** 47)
    try {
      sink.progress({ jobId, value: 0, max: 1, stage: 'queued' })
      let uploaded: string | undefined
      let size: { width: number; height: number } | undefined
      if (input) {
        const bytes = readFileSync(input.path)
        uploaded = await this.d.comfy.uploadImage(bytes, `archai-${jobId.slice(0, 8)}${extname(input.path) || '.png'}`)
        size = sizeForImage(input.width, input.height)
      } else {
        const s = SIZES[req.size ?? 'landscape']
        size = { width: s.width, height: s.height }
      }
      if (job.cancelled) throw new Cancelled()

      await this.d.gpu.beforeImages()
      const graph = applyBindings(wf.json, wf.bindings, {
        positive: req.positive,
        negative: req.negative,
        seed,
        steps: req.steps,
        cfg: req.cfg,
        denoise: req.denoise,
        strength: req.strength,
        checkpoint: req.checkpoint,
        controlnet: req.controlnet,
        image: uploaded,
        width: size.width,
        height: size.height,
        prefix: 'ArchAI/archai'
      })

      const clientId = randomUUID()
      const ws = await this.d.comfy.openSocket(clientId)
      job.ws = ws
      const promptId = await this.d.comfy.queue(graph, clientId)
      job.promptId = promptId
      if (job.cancelled) {
        await this.d.comfy.interrupt(promptId)
        throw new Cancelled()
      }
      sink.progress({ jobId, value: 0, max: 1, stage: 'loading' })
      const entry = ws ? await this.follow(ws, promptId, jobId, sink, job) : await this.poll(promptId, job)
      if (job.cancelled) throw new Cancelled()

      sink.progress({ jobId, value: 1, max: 1, stage: 'saving' })
      const refs = Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? []).filter((r) => r.type === 'output')
      if (refs.length === 0) throw new ComfyError('ComfyUI finished but returned no images. Check that the workflow ends in a Save Image node.')
      const checkpoint = req.checkpoint ?? (wf.bindings.checkpoint ? String(wf.json[wf.bindings.checkpoint.node]?.inputs[wf.bindings.checkpoint.input] ?? '') : '')
      const saved: GalleryImage[] = []
      for (const ref of refs) {
        const raw = await this.d.comfy.view(ref)
        saved.push(this.save(raw, req, wf, seed, checkpoint || null))
      }
      sink.done({ jobId, images: saved })
    } catch (e) {
      if (e instanceof Cancelled || job.cancelled) sink.error({ jobId, message: 'Stopped.' })
      else {
        log.error('image job failed', e)
        sink.error({ jobId, message: e instanceof ComfyError ? e.message : `The image job failed: ${e instanceof Error ? e.message : 'unknown error'}` })
      }
    } finally {
      job.ws?.close()
      this.jobs.delete(jobId)
    }
  }

  private save(raw: Buffer, req: GenerateRequest, wf: WorkflowInfo, seed: number, model: string | null): GalleryImage {
    const project = this.d.projects().get(req.projectId)!
    const now = new Date()
    const day = now.toISOString().slice(0, 10)
    const dir = join(this.d.galleryDir(), `${slug(project.name)}-${project.id}`, day)
    mkdirSync(dir, { recursive: true })
    const stamp = now.toISOString().slice(11, 19).replace(/:/g, '')
    const file = join(dir, `${day}_${stamp}_${seed}.png`)
    const steps = req.steps
    const parameters = `${req.positive}\nNegative prompt: ${req.negative}\nSeed: ${seed}${steps ? `, Steps: ${steps}` : ''}${model ? `, Model: ${model}` : ''}, Workflow: ${wf.name}`
    const bytes = addPngText(raw, {
      parameters,
      'archai:prompt': req.positive,
      'archai:negative': req.negative,
      'archai:seed': String(seed),
      'archai:model': model ?? '',
      'archai:workflow': wf.id,
      'archai:project': project.name,
      Software: 'ArchAI Studio'
    })
    writeFileSync(file, bytes)
    const dims = pngSize(bytes)
    const row = this.d.repo().add({
      project_id: project.id,
      path: file,
      width: dims?.width ?? null,
      height: dims?.height ?? null,
      positive: req.positive,
      negative: req.negative,
      seed,
      model,
      workflow: wf.id,
      mode: wf.mode,
      description: req.description
    })
    return toGallery(row)
  }

  /** Follows ComfyUI's websocket until our prompt finishes. */
  private follow(ws: WebSocket, promptId: string, jobId: string, sink: ImageSink, job: { cancelled: boolean }): Promise<ComfyHistoryEntry> {
    return new Promise((resolve, reject) => {
      let finished = false
      const finish = async () => {
        if (finished) return
        finished = true
        try {
          const h = await this.poll(promptId, job)
          resolve(h)
        } catch (e) {
          reject(e)
        }
      }
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return // binary preview frames
        let msg: { type?: string; data?: Record<string, unknown> }
        try {
          msg = JSON.parse(ev.data) as typeof msg
        } catch {
          return
        }
        const data = msg.data ?? {}
        if (data.prompt_id !== undefined && data.prompt_id !== promptId) return
        switch (msg.type) {
          case 'progress':
            sink.progress({ jobId, value: Number(data.value) || 0, max: Number(data.max) || 1, stage: 'sampling' })
            break
          case 'executing':
            if (data.node === null) void finish()
            break
          case 'execution_success':
            void finish()
            break
          case 'execution_error':
            finished = true
            reject(new ComfyError(`ComfyUI stopped at ${String(data.node_type ?? 'a node')}: ${String(data.exception_message ?? 'unknown error').trim()}`))
            break
          case 'execution_interrupted':
            finished = true
            reject(new Cancelled())
            break
        }
      })
      ws.addEventListener('close', () => {
        // The socket dropped (ComfyUI restarted, or we cancelled): fall back to polling.
        if (!finished) void finish()
      })
    })
  }

  /** Polls /history until the prompt has finished. Used when the websocket isn't available. */
  private async poll(promptId: string, job: { cancelled: boolean }): Promise<ComfyHistoryEntry> {
    const deadline = Date.now() + 30 * 60_000
    while (Date.now() < deadline) {
      if (job.cancelled) throw new Cancelled()
      const h = await this.d.comfy.history(promptId)
      if (h?.status?.status_str === 'error') {
        const err = h.status.messages?.find(([t]) => t === 'execution_error')?.[1]
        throw new ComfyError(`ComfyUI stopped with an error: ${String(err?.exception_message ?? 'see the ComfyUI window')}`)
      }
      if (h && (h.status?.completed || h.outputs)) return h
      await new Promise((r) => setTimeout(r, this.d.pollMs ?? 1500))
    }
    throw new ComfyError('ComfyUI took more than 30 minutes. Check the ComfyUI window for problems.')
  }
}

class Cancelled extends Error {}
