import { z } from 'zod'

export type ImageMode = 'text' | 'sketch' | 'variation'

export const BINDING_KEYS = ['positive', 'negative', 'seed', 'steps', 'cfg', 'denoise', 'checkpoint', 'controlnet', 'strength', 'image', 'width', 'height', 'prefix'] as const
export type BindingKey = (typeof BINDING_KEYS)[number]
export interface Binding {
  node: string
  input: string
}
export type Bindings = Partial<Record<BindingKey, Binding>>

/** A ComfyUI workflow in API format: node id -> { class_type, inputs }. */
export type ApiWorkflow = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: unknown }>

export interface WorkflowInfo {
  id: string
  name: string
  mode: ImageMode
  description: string
  builtIn: boolean
  bindings: Bindings
}

export interface StylePreset {
  id: string
  name: string
  positive: string
  negative: string
}

/** Style presets: added to your description before it goes to ComfyUI. */
export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'tropical-modern',
    name: 'Tropical modern',
    positive:
      'tropical modern architecture, deep overhanging eaves, timber louvres, off-form concrete and lime-washed walls, lush planting, open verandahs, soft diffused daylight, humid air, Sri Lanka',
    negative: 'snow, pine trees, desert, glass skyscraper'
  },
  {
    id: 'bawa-courtyard',
    name: 'Bawa-inspired courtyard',
    positive:
      'courtyard house inspired by Geoffrey Bawa, open-to-sky central courtyard (midula), clay tile roof on timber columns, white lime-plastered walls, frangipani tree, reflecting pool, dappled afternoon light, tropical garden, Sri Lankan vernacular',
    negative: 'modern glass facade, minimalist white box, cold light, snow'
  },
  {
    id: 'brutalist',
    name: 'Brutalist',
    positive: 'brutalist architecture, board-marked raw concrete, massive cantilevers, deep window reveals, strong chiaroscuro, overcast sky, weathered surfaces',
    negative: 'ornament, pastel colours, glossy cladding'
  },
  {
    id: 'scandinavian',
    name: 'Scandinavian',
    positive: 'Scandinavian architecture, pale timber cladding, simple pitched roof, large timber-framed windows, calm muted palette, soft northern light, birch trees',
    negative: 'tropical plants, ornament, saturated colours'
  },
  {
    id: 'night-exterior',
    name: 'Night exterior',
    positive: 'architectural exterior at blue hour, warm interior light glowing through windows, subtle landscape lighting, clear dusk sky, reflections on wet paving',
    negative: 'harsh floodlights, overexposed, daylight, lens flare'
  },
  {
    id: 'interior-daylight',
    name: 'Interior daylight',
    positive: 'architectural interior photograph, soft natural daylight from large openings, timber and terrazzo floor, lime plaster walls, minimal furniture, views to a garden, balanced exposure',
    negative: 'artificial lighting, clutter, fisheye distortion, people posing'
  }
]

/** Always added to the negative prompt. */
export const BASE_NEGATIVE = 'blurry, low quality, distorted perspective, warped lines, extra windows, text, watermark, signature, cartoon, deformed'

export const QUALITY_SUFFIX = 'architectural photography, sharp focus, realistic materials, correct perspective, high detail'

export function composePrompt(description: string, presetId: string | null): { positive: string; negative: string } {
  const p = STYLE_PRESETS.find((s) => s.id === presetId)
  const positive = [description.trim(), p?.positive, QUALITY_SUFFIX].filter(Boolean).join(', ')
  const negative = [p?.negative, BASE_NEGATIVE].filter(Boolean).join(', ')
  return { positive, negative }
}

export const SIZES = {
  landscape: { label: 'Landscape', width: 1216, height: 832 },
  square: { label: 'Square', width: 1024, height: 1024 },
  portrait: { label: 'Portrait', width: 832, height: 1216 },
  wide: { label: 'Wide', width: 1344, height: 768 }
} as const
export type SizeId = keyof typeof SIZES

/** Latent size for an input image: same aspect ratio, about 1 megapixel, multiples of 64. */
export function sizeForImage(w: number, h: number): { width: number; height: number } {
  if (!(w > 0 && h > 0)) return { width: 1024, height: 1024 }
  const scale = Math.sqrt((1024 * 1024) / (w * h))
  const snap = (v: number) => Math.max(512, Math.min(2048, Math.round((v * scale) / 64) * 64))
  return { width: snap(w), height: snap(h) }
}

/* ---------- workflow parsing ---------- */

export class WorkflowFormatError extends Error {}

/** Accepts only ComfyUI API-format JSON. Explains how to export it if it is the UI format. */
export function parseApiWorkflow(raw: unknown): ApiWorkflow {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new WorkflowFormatError('That file is not a ComfyUI workflow.')
  const o = raw as Record<string, unknown>
  if (Array.isArray(o.nodes) && Array.isArray(o.links)) {
    throw new WorkflowFormatError(
      'This is a ComfyUI workflow saved for the editor, not the API. In ComfyUI, open it and choose Workflow → Export (API), then import that file.'
    )
  }
  const entries = Object.entries(o)
  if (entries.length === 0) throw new WorkflowFormatError('That workflow is empty.')
  if (entries.length > 500) throw new WorkflowFormatError('That workflow has too many nodes.')
  for (const [id, node] of entries) {
    const n = node as { class_type?: unknown; inputs?: unknown }
    if (!n || typeof n !== 'object' || typeof n.class_type !== 'string' || !n.inputs || typeof n.inputs !== 'object') {
      throw new WorkflowFormatError(`Node "${id}" is not in ComfyUI API format. Export the workflow with Workflow → Export (API).`)
    }
  }
  if (!entries.some(([, n]) => /^SaveImage|PreviewImage$/.test((n as { class_type: string }).class_type))) {
    throw new WorkflowFormatError('The workflow has no Save Image node, so it would produce nothing to collect.')
  }
  return o as ApiWorkflow
}

const isLink = (v: unknown): v is [string, number] => Array.isArray(v) && v.length === 2 && typeof v[0] === 'string'

/** Finds the usual nodes in an imported workflow so you only need to confirm them. */
export function detectBindings(wf: ApiWorkflow): Bindings {
  const b: Bindings = {}
  const byClass = (re: RegExp) => Object.entries(wf).filter(([, n]) => re.test(n.class_type))
  const sampler = byClass(/^KSampler(Advanced)?$|SamplerCustom/)[0]
  if (sampler) {
    const [id, n] = sampler
    if ('seed' in n.inputs) b.seed = { node: id, input: 'seed' }
    else if ('noise_seed' in n.inputs) b.seed = { node: id, input: 'noise_seed' }
    if ('steps' in n.inputs) b.steps = { node: id, input: 'steps' }
    if ('cfg' in n.inputs) b.cfg = { node: id, input: 'cfg' }
    if ('denoise' in n.inputs) b.denoise = { node: id, input: 'denoise' }
    // Follow positive/negative links back to the text encoders (through ControlNet nodes if present).
    const follow = (link: unknown, depth = 0): string | null => {
      if (!isLink(link) || depth > 6) return null
      const node = wf[link[0]]
      if (!node) return null
      if (/CLIPTextEncode/.test(node.class_type) && typeof node.inputs.text === 'string') return link[0]
      const next = link[1] === 1 ? (node.inputs.negative ?? node.inputs.conditioning) : (node.inputs.positive ?? node.inputs.conditioning)
      return follow(next, depth + 1)
    }
    const pos = follow(n.inputs.positive)
    const neg = follow(n.inputs.negative)
    if (pos) b.positive = { node: pos, input: 'text' }
    if (neg) b.negative = { node: neg, input: 'text' }
  }
  const ckpt = byClass(/^CheckpointLoader/)[0]
  if (ckpt) b.checkpoint = { node: ckpt[0], input: 'ckpt_name' }
  const cn = byClass(/^ControlNetLoader$/)[0]
  if (cn) b.controlnet = { node: cn[0], input: 'control_net_name' }
  const apply = byClass(/^ControlNetApply/)[0]
  if (apply && 'strength' in apply[1].inputs) b.strength = { node: apply[0], input: 'strength' }
  const img = byClass(/^LoadImage$/)[0]
  if (img) b.image = { node: img[0], input: 'image' }
  const latent = byClass(/^Empty.*LatentImage$/)[0]
  if (latent) {
    b.width = { node: latent[0], input: 'width' }
    b.height = { node: latent[0], input: 'height' }
  }
  const save = byClass(/^SaveImage$/)[0]
  if (save) b.prefix = { node: save[0], input: 'filename_prefix' }
  return b
}

export function guessMode(b: Bindings): ImageMode {
  if (b.image && b.controlnet) return 'sketch'
  if (b.image) return 'variation'
  return 'text'
}

/** Checks that each binding points at a real node and input. Returns plain-language problems. */
export function checkBindings(wf: ApiWorkflow, b: Bindings, mode: ImageMode): string[] {
  const problems: string[] = []
  for (const [key, bind] of Object.entries(b) as [BindingKey, Binding][]) {
    const node = wf[bind.node]
    if (!node) problems.push(`The ${key} setting points at node ${bind.node}, which isn't in the workflow.`)
    else if (!(bind.input in node.inputs)) problems.push(`Node ${bind.node} (${node.class_type}) has no "${bind.input}" input for ${key}.`)
  }
  if (!b.positive) problems.push('Choose which node holds the prompt.')
  if (mode !== 'text' && !b.image) problems.push('This mode needs a Load Image node for your picture.')
  return problems
}

export interface JobValues {
  positive: string
  negative: string
  seed: number
  steps?: number
  cfg?: number
  denoise?: number
  checkpoint?: string
  controlnet?: string
  strength?: number
  image?: string
  width?: number
  height?: number
  prefix?: string
}

/** Fills your values into a copy of the workflow. Never changes the original. */
export function applyBindings(wf: ApiWorkflow, b: Bindings, v: JobValues): ApiWorkflow {
  const out = structuredClone(wf)
  for (const key of BINDING_KEYS) {
    const bind = b[key]
    const value = v[key]
    if (!bind || value === undefined || value === '') continue
    const node = out[bind.node]
    if (node && !isLink(node.inputs[bind.input])) node.inputs[bind.input] = value
  }
  return out
}

/* ---------- requests ---------- */

const Id = z.number().int().positive()

export const GenerateSchema = z
  .object({
    projectId: Id,
    workflowId: z.string().min(1).max(100),
    positive: z.string().trim().min(1, 'Describe the image first.').max(8000),
    negative: z.string().max(4000),
    seed: z.number().int().min(0).max(2 ** 48).nullable(),
    steps: z.number().int().min(1).max(150).optional(),
    cfg: z.number().min(0).max(30).optional(),
    denoise: z.number().min(0.05).max(1).optional(),
    strength: z.number().min(0).max(2).optional(),
    checkpoint: z.string().max(300).optional(),
    controlnet: z.string().max(300).optional(),
    size: z.enum(['landscape', 'square', 'portrait', 'wide']).optional(),
    /** Token from images:pickInput or a gallery image id. */
    input: z.union([z.object({ token: z.string().uuid() }), z.object({ imageId: Id })]).optional(),
    preset: z.string().max(60).nullable(),
    description: z.string().max(8000)
  })
  .strict()
export type GenerateRequest = z.input<typeof GenerateSchema>

export interface GalleryImage {
  id: number
  projectId: number
  url: string
  width: number | null
  height: number | null
  positive: string
  negative: string
  seed: number
  model: string | null
  workflow: string
  mode: ImageMode
  description: string
  createdAt: string
}

export interface PickedInput {
  token: string
  name: string
  width: number
  height: number
  url: string
}

export interface ComfyModels {
  checkpoints: string[]
  controlnets: string[]
}

export interface ImageJob {
  jobId: string
}
export interface ImageProgress {
  jobId: string
  value: number
  max: number
  stage: 'queued' | 'loading' | 'sampling' | 'saving'
}
export interface ImageDone {
  jobId: string
  images: GalleryImage[]
}
export interface ImageError {
  jobId: string
  message: string
}
