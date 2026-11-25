/**
 * First-run checks. Each one explains a failure in plain language and offers
 * a fix. Nothing is ever downloaded or installed automatically.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { dirname, parse } from 'node:path'
import { DISK_FAIL_BYTES, DISK_WARN_BYTES, GB, hasModel, type CheckResult } from '@shared/checks'
import type { Settings } from '@shared/settings'
import type { ComfyClient, ComfySystemStats } from './comfy'
import type { OllamaClient } from './ollama'

export interface GpuInfo {
  name: string
  vramGb?: number
  source: 'nvidia-smi' | 'electron' | 'comfyui'
}

export interface CheckDeps {
  ollama: OllamaClient
  comfy: ComfyClient
  /** nvidia-smi output, or null if it isn't available. */
  nvidiaSmi: () => Promise<string | null>
  /** GPU names Electron sees (no network). */
  electronGpus: () => Promise<{ vendorId: number; name?: string }[]>
  freeBytes: (dir: string) => Promise<number | null>
}

const gb = (b: number) => `${(b / GB).toFixed(b < 10 * GB ? 1 : 0)} GB`

export async function runChecks(s: Settings, deps: CheckDeps): Promise<CheckResult[]> {
  const [ollama, comfy, disk] = await Promise.all([checkOllama(s, deps), checkComfy(s, deps), checkDisk(s, deps)])
  const gpu = await checkGpu(deps, comfy.stats)
  return [...ollama, comfy.result, gpu, disk]
}

async function checkOllama(s: Settings, deps: CheckDeps): Promise<CheckResult[]> {
  const model = s.models.chat
  try {
    const version = await deps.ollama.version()
    const names = (await deps.ollama.tags()).map((m) => m.name)
    const reachable: CheckResult = { id: 'ollama', status: 'ok', title: 'Ollama is running', detail: `Version ${version} at ${s.endpoints.ollama}` }
    if (hasModel(names, model)) {
      return [reachable, { id: 'model', status: 'ok', title: `${model} is ready`, detail: 'The chat and script model is downloaded.' }]
    }
    return [
      reachable,
      {
        id: 'model',
        status: 'fail',
        title: `${model} isn't downloaded yet`,
        detail: names.length ? `Ollama has: ${names.join(', ')}.` : 'Ollama has no models yet.',
        fix: {
          text: `Open PowerShell and run this command. It downloads the model once${model === 'gpt-oss:20b' ? ' (about 13 GB)' : ''}, then everything works offline. Or pick a model you already have in Settings.`,
          command: `ollama pull ${model}`
        }
      }
    ]
  } catch {
    return [
      {
        id: 'ollama',
        status: 'fail',
        title: "Ollama isn't running",
        detail: `Nothing answered at ${s.endpoints.ollama}.`,
        fix: {
          text: 'Start Ollama from the Start menu (it sits in the system tray, near the clock), then check again. If it is not installed yet, get it from the Ollama website. You can also start it from PowerShell:',
          command: 'ollama serve',
          link: { label: 'Download Ollama', url: 'https://ollama.com/download/windows' }
        }
      },
      { id: 'model', status: 'fail', title: `Can't check for ${model}`, detail: 'Start Ollama first.' }
    ]
  }
}

async function checkComfy(s: Settings, deps: CheckDeps): Promise<{ result: CheckResult; stats: ComfySystemStats | null }> {
  try {
    const stats = await deps.comfy.systemStats()
    const v = stats.system?.comfyui_version
    return { stats, result: { id: 'comfy', status: 'ok', title: 'ComfyUI is running', detail: `${v ? `Version ${v} at ` : ''}${s.endpoints.comfy}` } }
  } catch {
    return {
      stats: null,
      result: {
        id: 'comfy',
        status: 'fail',
        title: "ComfyUI isn't running",
        detail: `Nothing answered at ${s.endpoints.comfy}. Chat and scripts still work without it. Only image generation needs it.`,
        fix: {
          text: 'Start ComfyUI, then check again. For the Windows portable version, double-click run_nvidia_gpu.bat. RTX 50-series cards like your 5080 need a recent ComfyUI with PyTorch for CUDA 12.8 or newer. From a ComfyUI folder you can also run:',
          command: `python main.py --listen 127.0.0.1 --port ${new URL(s.endpoints.comfy).port || 8188}`,
          link: { label: 'ComfyUI on GitHub', url: 'https://github.com/comfyanonymous/ComfyUI' }
        }
      }
    }
  }
}

export function parseNvidiaSmi(out: string): GpuInfo | null {
  const line = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
  if (!line) return null
  const [name, mem] = line.split(',').map((x) => x.trim())
  if (!name) return null
  const mib = Number(mem)
  return { name, vramGb: Number.isFinite(mib) && mib > 0 ? Math.round(mib / 1024) : undefined, source: 'nvidia-smi' }
}

export async function detectGpu(deps: CheckDeps, comfyStats: ComfySystemStats | null): Promise<GpuInfo | null> {
  const smi = await deps.nvidiaSmi().catch(() => null)
  const fromSmi = smi ? parseNvidiaSmi(smi) : null
  if (fromSmi) return fromSmi
  const cuda = comfyStats?.devices?.find((d) => d.type === 'cuda' && /nvidia/i.test(d.name))
  if (cuda) {
    const name = cuda.name.replace(/^cuda:\d+\s*/, '').replace(/\s*:\s*\w+$/, '')
    return { name, vramGb: cuda.vram_total ? Math.round(cuda.vram_total / GB) : undefined, source: 'comfyui' }
  }
  const eg = (await deps.electronGpus().catch(() => [])).find((g) => g.vendorId === 0x10de)
  if (eg) return { name: eg.name || 'NVIDIA GPU', source: 'electron' }
  return null
}

async function checkGpu(deps: CheckDeps, comfyStats: ComfySystemStats | null): Promise<CheckResult> {
  const gpu = await detectGpu(deps, comfyStats)
  if (!gpu) {
    return {
      id: 'gpu',
      status: 'warn',
      title: 'No NVIDIA graphics card found',
      detail: 'Ollama and ComfyUI need an NVIDIA card to run at a usable speed.',
      fix: {
        text: 'If you have one, install the latest NVIDIA Studio or Game Ready driver, restart, and check again.',
        link: { label: 'NVIDIA drivers', url: 'https://www.nvidia.com/en-us/drivers/' }
      }
    }
  }
  const vram = gpu.vramGb ? `, ${gpu.vramGb} GB video memory` : ''
  if (gpu.vramGb !== undefined && gpu.vramGb < 12) {
    return { id: 'gpu', status: 'warn', title: gpu.name, detail: `Found${vram}. gpt-oss:20b needs about 14 GB, so it will run slowly. Consider a smaller model.` }
  }
  return { id: 'gpu', status: 'ok', title: gpu.name, detail: `NVIDIA graphics card found${vram}.` }
}

async function checkDisk(s: Settings, deps: CheckDeps): Promise<CheckResult> {
  const free = await deps.freeBytes(s.folders.data)
  const where = s.folders.data
  if (free === null) return { id: 'disk', status: 'warn', title: 'Free space unknown', detail: `Couldn't read free space for ${where}.` }
  const base: Pick<CheckResult, 'id'> = { id: 'disk' }
  if (free < DISK_FAIL_BYTES) {
    return { ...base, status: 'fail', title: `Only ${gb(free)} free`, detail: `On the drive for ${where}.`, fix: { text: 'Free up space, or choose a data folder on another drive in the next step.' } }
  }
  if (free < DISK_WARN_BYTES) {
    return { ...base, status: 'warn', title: `${gb(free)} free`, detail: `On the drive for ${where}. Renders and documents add up. 20 GB or more is comfortable.`, fix: { text: 'You can keep image galleries on another drive in the next step.' } }
  }
  return { ...base, status: 'ok', title: `${gb(free)} free`, detail: `On the drive for ${where}.` }
}

/* ---------- real implementations of the dependencies ---------- */

export function runNvidiaSmi(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })
}

/** Free bytes on the drive holding dir (walks up to the nearest existing folder). */
export async function freeBytesFor(dir: string): Promise<number | null> {
  let d = dir
  const root = parse(dir).root
  while (!existsSync(d) && d !== root && dirname(d) !== d) d = dirname(d)
  try {
    const st = await statfs(d)
    return st.bavail * st.bsize
  } catch {
    return null
  }
}
