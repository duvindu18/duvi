import { z } from 'zod'
import { MODEL_KEYS } from './images'
import { LOOPBACK_HOSTS } from './net-policy'

/** A local service address: http on this computer only, any port. */
export const LoopbackUrl = z
  .string()
  .trim()
  .max(200)
  .refine((v) => {
    try {
      const u = new URL(v)
      return u.protocol === 'http:' && (LOOPBACK_HOSTS as readonly string[]).includes(u.hostname) && !u.username && !u.password && Number(u.port || 80) > 0
    } catch {
      return false
    }
  }, 'Use an address on this computer, for example http://127.0.0.1:11434')
  .transform((v) => v.replace(/\/+$/, ''))

const ModelName = z.string().trim().min(1).max(200)
const FolderPath = z.string().trim().min(1).max(1000)

export const SettingsSchema = z.object({
  version: z.literal(1),
  firstRunComplete: z.boolean(),
  theme: z.enum(['dark', 'light', 'phthalo', 'system']),
  endpoints: z.object({ ollama: LoopbackUrl, comfy: LoopbackUrl }),
  models: z.object({ chat: ModelName, scripts: ModelName, embed: ModelName }),
  chat: z.object({ contextLength: z.number().int().min(2048).max(131072) }),
  gpu: z.object({ turnTaking: z.boolean() }),
  /** Last-used model files per workflow (names as ComfyUI lists them), so SDXL and Flux choices never mix. */
  images: z.object({ byWorkflow: z.record(z.string().max(100), z.partialRecord(z.enum(MODEL_KEYS), z.string().max(300))) }),
  folders: z.object({ data: FolderPath, gallery: FolderPath.nullable() }),
  /** A ComfyUI installed by ArchAI Studio, and where to put image models. */
  comfy: z.object({ managedDir: FolderPath.nullable(), modelsDir: FolderPath.nullable(), autoStart: z.boolean() }),
  activeProjectId: z.number().int().positive().nullable()
})
export type Settings = z.infer<typeof SettingsSchema>

export const SettingsPatchSchema = z
  .object({
    firstRunComplete: z.boolean(),
    theme: SettingsSchema.shape.theme,
    endpoints: SettingsSchema.shape.endpoints.partial(),
    models: SettingsSchema.shape.models.partial(),
    chat: SettingsSchema.shape.chat.partial(),
    gpu: SettingsSchema.shape.gpu.partial(),
    images: SettingsSchema.shape.images.partial(),
    folders: SettingsSchema.shape.folders.partial(),
    comfy: SettingsSchema.shape.comfy.partial(),
    activeProjectId: SettingsSchema.shape.activeProjectId
  })
  .partial()
  .strict()
export type SettingsPatch = z.input<typeof SettingsPatchSchema>

export function defaultSettings(dataDir: string): Settings {
  return {
    version: 1,
    firstRunComplete: false,
    theme: 'dark',
    endpoints: { ollama: 'http://127.0.0.1:11434', comfy: 'http://127.0.0.1:8188' },
    models: { chat: 'gpt-oss:20b', scripts: 'gpt-oss:20b', embed: 'nomic-embed-text' },
    chat: { contextLength: 8192 },
    gpu: { turnTaking: true },
    images: { byWorkflow: {} },
    folders: { data: dataDir, gallery: null },
    comfy: { managedDir: null, modelsDir: null, autoStart: true },
    activeProjectId: null
  }
}

type Patch = z.output<typeof SettingsPatchSchema>

export function applyPatch(s: Settings, p: Patch): Settings {
  return SettingsSchema.parse({
    ...s,
    ...(p.firstRunComplete !== undefined && { firstRunComplete: p.firstRunComplete }),
    ...(p.theme !== undefined && { theme: p.theme }),
    ...(p.activeProjectId !== undefined && { activeProjectId: p.activeProjectId }),
    endpoints: { ...s.endpoints, ...p.endpoints },
    models: { ...s.models, ...p.models },
    chat: { ...s.chat, ...p.chat },
    gpu: { ...s.gpu, ...p.gpu },
    images: { ...s.images, ...p.images },
    folders: { ...s.folders, ...p.folders },
    comfy: { ...s.comfy, ...p.comfy }
  })
}

/** Ports the network guard should allow, derived from the endpoints. */
export function loopbackPorts(s: Settings): number[] {
  return [...new Set([s.endpoints.ollama, s.endpoints.comfy].map((u) => Number(new URL(u).port || 80)))]
}

/** Above this context length gpt-oss:20b may not fit in 16 GB of VRAM. */
export const CONTEXT_VRAM_WARNING = 16384
