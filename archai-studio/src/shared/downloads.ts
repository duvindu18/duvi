/**
 * What first-time setup can download for you. Sizes are approximate and only
 * for planning; the real size and SHA-256 checksum are read from the official
 * source when you click Download, and every file is checked against them.
 */

export type ComponentId = 'ollama-app' | 'gpt-oss-20b' | 'nomic-embed' | 'comfyui' | 'sdxl-base' | 'sdxl-canny' | 'flux-schnell'

export type Source =
  | { kind: 'github-asset'; repo: string; asset: string; checksumAsset?: string }
  | { kind: 'ollama-pull'; model: string }
  | { kind: 'hf-file'; repo: string; file: string; folder: 'checkpoints' | 'controlnet'; saveAs: string }

export interface Component {
  id: ComponentId
  name: string
  what: string
  group: 'programs' | 'chat' | 'images'
  approxBytes: number
  licence: string
  licenceUrl: string
  source: Source
  /** Programs (installers) are offered only in the Setup.exe build, never in the Store build. */
  program: boolean
  /** Ticked by default when missing. */
  recommended: boolean
  /** Needs this to be installed and running first. */
  requires?: ComponentId
}

const GB = 1e9

export const COMPONENTS: Component[] = [
  {
    id: 'ollama-app',
    name: 'Ollama for Windows',
    what: 'Runs the language models for Chat and Script Studio.',
    group: 'programs',
    approxBytes: 1.95 * GB,
    licence: 'MIT',
    licenceUrl: 'https://github.com/ollama/ollama/blob/main/LICENSE',
    source: { kind: 'github-asset', repo: 'ollama/ollama', asset: 'OllamaSetup.exe', checksumAsset: 'sha256sum.txt' },
    program: true,
    recommended: true
  },
  {
    id: 'gpt-oss-20b',
    name: 'gpt-oss:20b',
    what: 'The chat and scripting model.',
    group: 'chat',
    approxBytes: 13.8 * GB,
    licence: 'Apache 2.0',
    licenceUrl: 'https://ollama.com/library/gpt-oss',
    source: { kind: 'ollama-pull', model: 'gpt-oss:20b' },
    program: false,
    recommended: true,
    requires: 'ollama-app'
  },
  {
    id: 'nomic-embed',
    name: 'nomic-embed-text',
    what: 'Reads your PDFs for Documents (phase 2). Small.',
    group: 'chat',
    approxBytes: 0.27 * GB,
    licence: 'Apache 2.0',
    licenceUrl: 'https://ollama.com/library/nomic-embed-text',
    source: { kind: 'ollama-pull', model: 'nomic-embed-text' },
    program: false,
    recommended: true,
    requires: 'ollama-app'
  },
  {
    id: 'comfyui',
    name: 'ComfyUI (portable, NVIDIA)',
    what: 'Runs the image models for Visual Studio. ArchAI Studio can start and stop it for you.',
    group: 'programs',
    approxBytes: 2.1 * GB,
    licence: 'GPL-3.0',
    licenceUrl: 'https://github.com/Comfy-Org/ComfyUI/blob/master/LICENSE',
    source: { kind: 'github-asset', repo: 'Comfy-Org/ComfyUI', asset: 'ComfyUI_windows_portable_nvidia.7z' },
    program: true,
    recommended: true
  },
  {
    id: 'sdxl-base',
    name: 'SDXL base 1.0',
    what: 'The main image model for renders.',
    group: 'images',
    approxBytes: 6.94 * GB,
    licence: 'CreativeML Open RAIL++-M',
    licenceUrl: 'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/blob/main/LICENSE.md',
    source: { kind: 'hf-file', repo: 'stabilityai/stable-diffusion-xl-base-1.0', file: 'sd_xl_base_1.0.safetensors', folder: 'checkpoints', saveAs: 'sd_xl_base_1.0.safetensors' },
    program: false,
    recommended: true,
    requires: 'comfyui'
  },
  {
    id: 'sdxl-canny',
    name: 'SDXL Canny ControlNet (xinsir)',
    what: 'Lets Visual Studio follow the lines of your sketch.',
    group: 'images',
    approxBytes: 2.5 * GB,
    licence: 'Apache 2.0',
    licenceUrl: 'https://huggingface.co/xinsir/controlnet-canny-sdxl-1.0',
    source: { kind: 'hf-file', repo: 'xinsir/controlnet-canny-sdxl-1.0', file: 'diffusion_pytorch_model.safetensors', folder: 'controlnet', saveAs: 'xinsir-controlnet-canny-sdxl-1.0.safetensors' },
    program: false,
    recommended: true,
    requires: 'comfyui'
  },
  {
    id: 'flux-schnell',
    name: 'Flux.1 schnell (fp8, all-in-one)',
    what: 'Optional. A fast Flux model for text-to-image and variations. Large.',
    group: 'images',
    approxBytes: 17.24 * GB,
    licence: 'Apache 2.0',
    licenceUrl: 'https://huggingface.co/Comfy-Org/Flux-1-Schnell',
    source: { kind: 'hf-file', repo: 'Comfy-Org/Flux-1-Schnell', file: 'flux1-schnell-fp8.safetensors', folder: 'checkpoints', saveAs: 'flux1-schnell-fp8.safetensors' },
    program: false,
    recommended: false,
    requires: 'comfyui'
  }
]

export type ComponentState = 'installed' | 'missing' | 'unknown' | 'unavailable'

export interface ComponentStatus {
  id: ComponentId
  state: ComponentState
  /** Why it can't be offered (Store build, not Windows, needs another item). */
  note?: string
}

export type DownloadPhase = 'waiting' | 'checking' | 'downloading' | 'verifying' | 'installing' | 'done' | 'failed' | 'skipped'

export interface DownloadProgress {
  runId: string
  id: ComponentId
  phase: DownloadPhase
  bytes: number
  total: number
  /** Bytes per second, smoothed. */
  rate: number
  message?: string
}

export interface DownloadRunDone {
  runId: string
  ok: boolean
  failed: ComponentId[]
}

/** Extra free space a component needs while installing (unpacking ComfyUI needs room for the archive and the files). */
export function spaceNeeded(c: Component): number {
  return c.id === 'comfyui' ? c.approxBytes * 4 : c.approxBytes
}

export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 10e9 ? 0 : 1)} GB`
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  return `${Math.max(0, Math.round(n / 1e3))} KB`
}
