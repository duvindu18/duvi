/**
 * "Download and install" in first-time setup. Downloads only what you tick, only
 * while you are running it, from the official sources, and checks every file.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { hasModel } from '@shared/checks'
import { COMPONENTS, spaceNeeded, type Component, type ComponentId, type ComponentStatus, type DownloadProgress, type DownloadRunDone } from '@shared/downloads'
import { log } from '../log'
import type { ComfyClient } from '../services/comfy'
import { DownloadError, downloadFile, type FetchLike } from '../services/downloader'
import type { OllamaClient } from '../services/ollama'

export interface SetupDeps {
  /** Network access for purpose "setup-download" (guarded). */
  fetch: FetchLike
  /** HEAD/GET without following redirects (to read Hugging Face's checksum headers). */
  fetchNoRedirect: FetchLike
  bases: { githubApi: string; github: string; hf: string }
  ollama: OllamaClient
  comfy: ComfyClient
  dataDir: () => string
  /** models folder of the ComfyUI to fill (managed or yours). */
  modelsDir: () => string | null
  managedComfyDir: () => string | null
  setManagedComfyDir: (dir: string) => void
  platform: NodeJS.Platform
  storeBuild: boolean
  verifySignature: (file: string, publisher: string) => Promise<boolean>
  runInstaller: (file: string, args: string[]) => Promise<number>
  extract7z: (archive: string, destDir: string, onPct: (pct: number) => void, signal?: AbortSignal) => Promise<void>
  startComfy: (dir: string) => Promise<void>
  freeBytes: (dir: string) => Promise<number | null>
  ollamaOnDisk: () => boolean
  isPortableComfy: (dir: string) => boolean
  /** How long to wait for Ollama/ComfyUI to answer after installing. */
  waitMs?: number
}

export interface SetupSink {
  progress(p: DownloadProgress): void
  done(d: DownloadRunDone): void
}

interface Resolved {
  url: string
  size?: number
  sha256?: string
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class SetupService {
  private readonly runs = new Map<string, AbortController>()

  constructor(private readonly d: SetupDeps) {}

  private component(id: ComponentId): Component {
    return COMPONENTS.find((c) => c.id === id)!
  }

  /** Programs are offered only in the Setup.exe build on Windows. */
  private programNote(c: Component): string | undefined {
    if (!c.program) return undefined
    if (this.d.storeBuild) return "The Microsoft Store version can't install other programs. Install it from its website, then check again."
    if (this.d.platform !== 'win32') return 'Installs on Windows only.'
    return undefined
  }

  async status(): Promise<ComponentStatus[]> {
    const ollamaUp = await this.d.ollama.version(1500).then(() => true, () => false)
    const models = ollamaUp ? (await this.d.ollama.tags(3000).catch(() => [])).map((m) => m.name) : []
    const comfyUp = await this.d.comfy.systemStats(1500).then(() => true, () => false)
    const managed = this.d.managedComfyDir()
    const modelsDir = this.d.modelsDir()
    return COMPONENTS.map((c): ComponentStatus => {
      const note = this.programNote(c)
      const src = c.source
      switch (c.id) {
        case 'ollama-app':
          return ollamaUp || this.d.ollamaOnDisk() ? { id: c.id, state: 'installed' } : { id: c.id, state: note ? 'unavailable' : 'missing', note }
        case 'comfyui':
          return comfyUp || (managed && this.d.isPortableComfy(managed)) ? { id: c.id, state: 'installed' } : { id: c.id, state: note ? 'unavailable' : 'missing', note }
      }
      if (src.kind === 'ollama-pull') {
        if (!ollamaUp) return { id: c.id, state: 'unknown', note: 'Checked once Ollama is running.' }
        return { id: c.id, state: hasModel(models, src.model) ? 'installed' : 'missing' }
      }
      if (src.kind === 'hf-file') {
        if (!modelsDir) return { id: c.id, state: 'unknown', note: 'Install ComfyUI first, or choose your ComfyUI folder.' }
        return { id: c.id, state: existsSync(join(modelsDir, src.folder, src.saveAs)) ? 'installed' : 'missing' }
      }
      return { id: c.id, state: 'unknown' }
    })
  }

  /** Free space on the data drive, and what the chosen items need. */
  async plan(ids: ComponentId[]): Promise<{ need: number; free: number | null }> {
    const need = ids.map((id) => spaceNeeded(this.component(id))).reduce((a, b) => a + b, 0)
    return { need, free: await this.d.freeBytes(this.d.dataDir()) }
  }

  async start(ids: ComponentId[], sink: SetupSink): Promise<{ runId: string }> {
    const order = COMPONENTS.map((c) => c.id).filter((id) => ids.includes(id))
    for (const id of order) {
      const note = this.programNote(this.component(id))
      if (note) throw new Error(`${this.component(id).name}: ${note}`)
    }
    const { need, free } = await this.plan(order)
    if (free !== null && free < need * 1.05) {
      throw new Error(`These downloads need about ${Math.ceil(need / 1e9)} GB, but only ${Math.floor(free / 1e9)} GB is free on that drive. Untick something, or free up space.`)
    }
    const runId = randomUUID()
    const ctl = new AbortController()
    this.runs.set(runId, ctl)
    void this.run(runId, order, sink, ctl.signal)
    return { runId }
  }

  cancel(runId: string): boolean {
    const c = this.runs.get(runId)
    c?.abort()
    return Boolean(c)
  }

  private async run(runId: string, order: ComponentId[], sink: SetupSink, signal: AbortSignal): Promise<void> {
    const failed: ComponentId[] = []
    for (const id of order) sink.progress({ runId, id, phase: 'waiting', bytes: 0, total: 0, rate: 0 })
    for (const id of order) {
      const c = this.component(id)
      if (signal.aborted) {
        sink.progress({ runId, id, phase: 'skipped', bytes: 0, total: 0, rate: 0, message: 'Stopped.' })
        continue
      }
      if (c.requires && failed.includes(c.requires)) {
        failed.push(id)
        sink.progress({ runId, id, phase: 'skipped', bytes: 0, total: 0, rate: 0, message: `Skipped because ${this.component(c.requires).name} didn't install.` })
        continue
      }
      // Smoothed speed for "time left".
      let lastT = Date.now()
      let lastB = 0
      let rate = 0
      const report = (phase: DownloadProgress['phase'], bytes: number, total: number, message?: string) => {
        const now = Date.now()
        if (now > lastT && bytes >= lastB) {
          const inst = ((bytes - lastB) * 1000) / (now - lastT)
          rate = rate ? rate * 0.8 + inst * 0.2 : inst
        }
        lastT = now
        lastB = bytes
        sink.progress({ runId, id, phase, bytes, total, rate, message })
      }
      try {
        report('checking', 0, 0)
        await this.install(c, report, signal)
        report('done', 1, 1)
      } catch (e) {
        failed.push(id)
        const msg = signal.aborted ? 'Stopped. Run it again to resume.' : e instanceof Error ? e.message : 'Unknown error'
        log.error(`setup: ${id} failed`, e)
        sink.progress({ runId, id, phase: 'failed', bytes: 0, total: 0, rate: 0, message: msg })
      }
    }
    this.runs.delete(runId)
    sink.done({ runId, ok: failed.length === 0, failed })
  }

  private async install(c: Component, report: (phase: DownloadProgress['phase'], b: number, t: number, m?: string) => void, signal: AbortSignal): Promise<void> {
    const src = c.source
    const downloads = join(this.d.dataDir(), 'Downloads')

    if (src.kind === 'ollama-pull') {
      await this.waitFor(() => this.d.ollama.version(1500), 'Ollama')
      await this.d.ollama.pull(src.model, (b, t) => report('downloading', b, t), signal)
      return
    }

    if (src.kind === 'hf-file') {
      const dir = this.d.modelsDir()
      if (!dir) throw new Error("ArchAI Studio doesn't know where your ComfyUI models folder is. Install ComfyUI here, or choose your ComfyUI folder.")
      const r = await this.resolveHf(src.repo, src.file)
      await downloadFile({
        url: r.url,
        dest: join(dir, src.folder, src.saveAs),
        fetch: this.d.fetch,
        expectedSize: r.size,
        expectedSha256: r.sha256,
        signal,
        onProgress: (b, t) => report('downloading', b, t)
      })
      return
    }

    // GitHub release asset: the Ollama installer or the ComfyUI archive.
    const r = await this.resolveGithub(src.repo, src.asset, src.checksumAsset)
    if (!r.sha256) throw new Error(`${c.name}: no published checksum was found, so the download was not started.`)
    const file = join(downloads, src.asset)
    await downloadFile({ url: r.url, dest: file, fetch: this.d.fetch, expectedSize: r.size, expectedSha256: r.sha256, signal, onProgress: (b, t) => report('downloading', b, t) }).catch(
      (e: unknown) => {
        // A complete, verified file from an earlier run is fine to reuse.
        if (e instanceof DownloadError && /already there/.test(e.message)) return
        throw e
      }
    )

    if (c.id === 'ollama-app') {
      report('verifying', 0, 1, "Checking the installer's digital signature…")
      if (!(await this.d.verifySignature(file, 'Ollama'))) {
        throw new Error('The Ollama installer is not signed by Ollama, so it was not run. Download it from ollama.com instead.')
      }
      report('installing', 0, 1, 'Installing Ollama…')
      const code = await this.d.runInstaller(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'])
      if (code !== 0) throw new Error(`The Ollama installer stopped with code ${code}. Try running it yourself from ${file}.`)
      await this.waitFor(() => this.d.ollama.version(1500), 'Ollama')
      safeDelete(file)
      return
    }

    if (c.id === 'comfyui') {
      const tools = join(this.d.dataDir(), 'Tools')
      report('installing', 0, 100, 'Unpacking ComfyUI…')
      await this.d.extract7z(file, tools, (pct) => report('installing', pct, 100, 'Unpacking ComfyUI…'), signal)
      const dir = join(tools, 'ComfyUI_windows_portable')
      if (!this.d.isPortableComfy(dir)) throw new Error('ComfyUI unpacked, but its files are not where expected. Try again, or install ComfyUI yourself.')
      this.d.setManagedComfyDir(dir)
      safeDelete(file)
      report('installing', 100, 100, 'Starting ComfyUI for the first time. This can take a minute…')
      await this.d.startComfy(dir)
      await this.waitFor(() => this.d.comfy.systemStats(2000), 'ComfyUI', 4)
      return
    }
  }

  private async waitFor(probe: () => Promise<unknown>, name: string, factor = 1): Promise<void> {
    const deadline = Date.now() + (this.d.waitMs ?? 90_000) * factor
    while (Date.now() < deadline) {
      if (await probe().then(() => true, () => false)) return
      await sleep(Math.min(2000, (this.d.waitMs ?? 90_000) / 10))
    }
    throw new Error(`${name} didn't start. Start it from the Start menu, then run the download again.`)
  }

  /** Latest release asset, with its SHA-256 from GitHub (or the project's checksum file). */
  async resolveGithub(repo: string, asset: string, checksumAsset?: string): Promise<Resolved> {
    const res = await this.d.fetch(`${this.d.bases.githubApi}/repos/${repo}/releases/latest`, { headers: { accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(`Couldn't read the latest ${repo} release from GitHub (${res.status}). Check your internet connection.`)
    const rel = (await res.json()) as { assets?: { name: string; size: number; digest?: string | null; browser_download_url: string }[] }
    const a = rel.assets?.find((x) => x.name === asset)
    if (!a) throw new Error(`The latest ${repo} release has no ${asset}. The project may have renamed it; install it from its website.`)
    let sha = a.digest?.startsWith('sha256:') ? a.digest.slice(7).toLowerCase() : undefined
    if (checksumAsset) {
      const sums = rel.assets?.find((x) => x.name === checksumAsset)
      if (sums) {
        const t = await this.d.fetch(sums.browser_download_url)
        if (t.ok) {
          const line = (await t.text()).split(/\r?\n/).find((l) => l.trim().endsWith(asset))
          const fromFile = line?.trim().split(/\s+/)[0]?.toLowerCase()
          if (fromFile && /^[0-9a-f]{64}$/.test(fromFile)) {
            if (sha && sha !== fromFile) throw new Error(`The published checksums for ${asset} disagree, so it was not downloaded.`)
            sha = fromFile
          }
        }
      }
    }
    return { url: a.browser_download_url, size: a.size, sha256: sha }
  }

  /** Hugging Face file: size and SHA-256 from the resolve headers. */
  async resolveHf(repo: string, file: string): Promise<Resolved> {
    const url = `${this.d.bases.hf}/${repo}/resolve/main/${file}`
    const res = await this.d.fetchNoRedirect(url, { method: 'HEAD' })
    if (res.status === 401 || res.status === 403) throw new Error(`${repo} needs a Hugging Face login, which ArchAI Studio doesn't use. Download it yourself from huggingface.co.`)
    if (res.status === 404) throw new Error(`${file} is no longer in ${repo} on Hugging Face.`)
    const size = Number(res.headers.get('x-linked-size') ?? res.headers.get('content-length') ?? NaN)
    const sha = (res.headers.get('x-linked-etag') ?? '').replace(/"/g, '').toLowerCase()
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error(`Hugging Face didn't publish a checksum for ${file}, so it was not downloaded.`)
    return { url, size: Number.isFinite(size) ? size : undefined, sha256: sha }
  }
}

function safeDelete(file: string): void {
  try {
    unlinkSync(file) // the installer we downloaded ourselves, no longer needed
  } catch {
    /* ignore */
  }
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8')
}
