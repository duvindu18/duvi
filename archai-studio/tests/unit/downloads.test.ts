import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { checkUrl, setTestDownloadOrigin } from '@shared/net-policy'
import { COMPONENTS, type ComponentId, type DownloadProgress, type DownloadRunDone } from '@shared/downloads'
import { SetupService, type SetupDeps } from '../../src/main/features/setup'
import { setNetPolicy } from '../../src/main/net-guard'
import { ComfyClient } from '../../src/main/services/comfy'
import { downloadFile, DownloadError, sha256File } from '../../src/main/services/downloader'
import { OllamaClient } from '../../src/main/services/ollama'
import { extract7z, sevenZipPath } from '../../src/main/services/win-tools'
import { startFakeComfy } from '../fakes/fake-comfy'
import { startFakeInternet } from '../fakes/fake-internet'
import { startFakeOllama } from '../fakes/fake-ollama'
import type { FakeServer } from '../fakes/http-fake'

const servers: FakeServer[] = []
afterEach(async () => {
  setTestDownloadOrigin(null)
  await Promise.all(servers.splice(0).map((s) => s.close()))
})
const tmp = () => mkdtempSync(join(tmpdir(), 'archai-dl-'))
const blob = (n: number, seed = 1) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251))

describe('download network rules', () => {
  const p = { loopbackPorts: [] }
  it('allows the official download hosts only for setup downloads', () => {
    expect(checkUrl('https://huggingface.co/x/resolve/main/y', 'setup-download', p).allowed).toBe(true)
    expect(checkUrl('https://us.aws.cdn.hf.co/xet-bridge-us/abc', 'setup-download', p).allowed).toBe(true)
    expect(checkUrl('https://cdn-lfs-us-1.huggingface.co/abc', 'setup-download', p).allowed).toBe(true)
    expect(checkUrl('https://release-assets.githubusercontent.com/x', 'setup-download', p).allowed).toBe(true)
    expect(checkUrl('https://evilhf.co/x', 'setup-download', p).allowed).toBe(false)
    expect(checkUrl('https://hf.co.evil.com/x', 'setup-download', p).allowed).toBe(false)
    expect(checkUrl('http://huggingface.co/x', 'setup-download', p).allowed).toBe(false)
    expect(checkUrl('https://huggingface.co/x', 'github-import', p).allowed).toBe(false)
    expect(checkUrl('https://huggingface.co/x', 'local-ai', p).allowed).toBe(false)
  })
})

describe('downloader', () => {
  it('resumes after a dropped connection and verifies the checksum', async () => {
    const bytes = blob(300_000)
    const net = await startFakeInternet({ github: {}, hf: { 'a/b': { 'm.safetensors': { bytes } } }, dropAfterBytes: 100_000 })
    servers.push(net)
    const dest = join(tmp(), 'm.safetensors')
    const sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex')
    const url = `${net.url}/cdn/a/b/m.safetensors`
    await expect(downloadFile({ url, dest, fetch, expectedSize: bytes.length, expectedSha256: sha })).rejects.toThrow(/incomplete|terminated|fetch failed/i)
    expect(existsSync(`${dest}.part`)).toBe(true)
    await downloadFile({ url, dest, fetch, expectedSize: bytes.length, expectedSha256: sha })
    expect(readFileSync(dest).equals(bytes)).toBe(true)
    expect(existsSync(`${dest}.part`)).toBe(false)
    expect(net.served.at(-1)?.range).toMatch(/^bytes=\d+-$/)
  })

  it('discards a file that fails its checksum', async () => {
    const bytes = blob(5000)
    const net = await startFakeInternet({ github: {}, hf: { 'a/b': { f: { bytes } } } })
    servers.push(net)
    const dest = join(tmp(), 'f')
    await expect(downloadFile({ url: `${net.url}/cdn/a/b/f`, dest, fetch, expectedSha256: '0'.repeat(64) })).rejects.toThrow(/checksum/)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('never replaces a file that is already there', async () => {
    const dir = tmp()
    const dest = join(dir, 'mine.safetensors')
    writeFileSync(dest, 'my own file')
    await expect(downloadFile({ url: 'http://127.0.0.1:9/x', dest, fetch })).rejects.toThrow(DownloadError)
    expect(readFileSync(dest, 'utf8')).toBe('my own file')
  })
})

describe('7-Zip', () => {
  it('unpacks archives with the bundled 7-Zip', async () => {
    const dir = tmp()
    mkdirSync(join(dir, 'src', 'ComfyUI_windows_portable'), { recursive: true })
    writeFileSync(join(dir, 'src', 'ComfyUI_windows_portable', 'hello.txt'), 'hi')
    execFileSync(sevenZipPath(), ['a', join(dir, 'a.7z'), 'ComfyUI_windows_portable'], { cwd: join(dir, 'src') })
    const pcts: number[] = []
    await extract7z(join(dir, 'a.7z'), join(dir, 'out'), (p) => pcts.push(p))
    expect(readFileSync(join(dir, 'out', 'ComfyUI_windows_portable', 'hello.txt'), 'utf8')).toBe('hi')
  })
})

async function setupEnv(over: Partial<SetupDeps> = {}, internet?: Parameters<typeof startFakeInternet>[0]) {
  const ollamaBytes = blob(40_000, 3)
  const comfyArchiveDir = tmp()
  mkdirSync(join(comfyArchiveDir, 'ComfyUI_windows_portable', 'python_embeded'), { recursive: true })
  mkdirSync(join(comfyArchiveDir, 'ComfyUI_windows_portable', 'ComfyUI', 'models', 'checkpoints'), { recursive: true })
  writeFileSync(join(comfyArchiveDir, 'ComfyUI_windows_portable', 'python_embeded', 'python.exe'), 'x')
  writeFileSync(join(comfyArchiveDir, 'ComfyUI_windows_portable', 'python_embeded', 'python'), 'x')
  writeFileSync(join(comfyArchiveDir, 'ComfyUI_windows_portable', 'ComfyUI', 'main.py'), '# fake')
  execFileSync(sevenZipPath(), ['a', join(comfyArchiveDir, 'c.7z'), 'ComfyUI_windows_portable'], { cwd: comfyArchiveDir })
  const comfyBytes = readFileSync(join(comfyArchiveDir, 'c.7z'))
  const sdxl = blob(70_000, 5)
  const ollamaSha = (await import('node:crypto')).createHash('sha256').update(ollamaBytes).digest('hex')
  const net = await startFakeInternet(
    internet ?? {
      github: {
        'ollama/ollama': { 'OllamaSetup.exe': { bytes: ollamaBytes }, 'sha256sum.txt': { bytes: Buffer.from(`${ollamaSha}  ./OllamaSetup.exe\n`) } },
        'Comfy-Org/ComfyUI': { 'ComfyUI_windows_portable_nvidia.7z': { bytes: comfyBytes } }
      },
      hf: {
        'stabilityai/stable-diffusion-xl-base-1.0': { 'sd_xl_base_1.0.safetensors': { bytes: sdxl } },
        'xinsir/controlnet-canny-sdxl-1.0': { 'diffusion_pytorch_model.safetensors': { bytes: blob(30_000, 7) } },
        'Comfy-Org/Flux-1-Schnell': { 'flux1-schnell-fp8.safetensors': { bytes: blob(10_000, 9), gated: true } }
      }
    }
  )
  servers.push(net)
  const ollama = await startFakeOllama({ models: [] })
  const comfy = await startFakeComfy()
  servers.push(ollama, comfy)
  setNetPolicy({ loopbackPorts: [ollama.port, comfy.port] })
  setTestDownloadOrigin(net.url)
  const data = tmp()
  let managed: string | null = null
  const calls: string[] = []
  const deps: SetupDeps = {
    fetch: (u, i) => fetch(u, i),
    fetchNoRedirect: (u, i) => fetch(u, { ...i, redirect: 'manual' }),
    bases: { githubApi: net.url, github: net.url, hf: net.url },
    ollama: new OllamaClient(() => ollama.url),
    comfy: new ComfyClient(() => comfy.url),
    dataDir: () => data,
    modelsDir: () => (managed ? join(managed, 'ComfyUI', 'models') : null),
    managedComfyDir: () => managed,
    setManagedComfyDir: (d) => (managed = d),
    platform: 'win32',
    storeBuild: false,
    verifySignature: async (f, pub) => {
      calls.push(`verify:${pub}`)
      return existsSync(f)
    },
    runInstaller: async (f, args) => {
      calls.push(`install:${args.join(' ')}`)
      return existsSync(f) ? 0 : 1
    },
    extract7z,
    startComfy: async () => void calls.push('startComfy'),
    freeBytes: async () => 500e9,
    ollamaOnDisk: () => false,
    isPortableComfy: (d) => existsSync(join(d, 'ComfyUI', 'main.py')),
    waitMs: 300,
    ...over
  }
  return { svc: new SetupService(deps), net, ollama, data, calls, get managed() { return managed } }
}

function collect() {
  const progress: DownloadProgress[] = []
  let resolve!: (d: DownloadRunDone) => void
  const done = new Promise<DownloadRunDone>((r) => (resolve = r))
  return { progress, done, sink: { progress: (p: DownloadProgress) => progress.push(p), done: resolve } }
}

describe('setup downloads', () => {
  it('installs Ollama (signed), ComfyUI (unpacked and started) and SDXL, in order', async () => {
    const env = await setupEnv()
    const k = collect()
    const ids: ComponentId[] = ['sdxl-base', 'comfyui', 'ollama-app']
    await env.svc.start(ids, k.sink)
    const r = await k.done
    expect(r).toMatchObject({ ok: true, failed: [] })
    expect(env.calls).toEqual(['verify:Ollama', 'install:/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', 'startComfy'])
    expect(env.managed).toBe(join(env.data, 'Tools', 'ComfyUI_windows_portable'))
    expect(existsSync(join(env.managed!, 'ComfyUI', 'models', 'checkpoints', 'sd_xl_base_1.0.safetensors'))).toBe(true)
    // Installers we downloaded are removed afterwards.
    expect(existsSync(join(env.data, 'Downloads', 'OllamaSetup.exe'))).toBe(false)
    expect(existsSync(join(env.data, 'Downloads', 'ComfyUI_windows_portable_nvidia.7z'))).toBe(false)
    // Order: programs before the models that need them.
    const firstDone = (id: string) => k.progress.findIndex((p) => p.id === id && p.phase === 'done')
    expect(firstDone('ollama-app')).toBeLessThan(firstDone('comfyui'))
    expect(firstDone('comfyui')).toBeLessThan(firstDone('sdxl-base'))
  })

  it('pulls Ollama models with progress', async () => {
    const env = await setupEnv()
    const k = collect()
    await env.svc.start(['gpt-oss-20b'], k.sink)
    expect((await k.done).ok).toBe(true)
    expect(env.ollama.requests.some((q) => q.path === '/api/pull' && q.body.includes('gpt-oss:20b'))).toBe(true)
  })

  it('refuses an installer that is not signed by Ollama', async () => {
    const env = await setupEnv({ verifySignature: async () => false })
    const k = collect()
    await env.svc.start(['ollama-app', 'gpt-oss-20b'], k.sink)
    const r = await k.done
    expect(r.failed).toEqual(['ollama-app', 'gpt-oss-20b'])
    expect(k.progress.find((p) => p.id === 'ollama-app' && p.phase === 'failed')?.message).toMatch(/not signed by Ollama/)
    expect(k.progress.find((p) => p.id === 'gpt-oss-20b' && p.phase === 'skipped')?.message).toMatch(/didn't install/)
  })

  it('refuses a download whose published checksum is wrong', async () => {
    const env = await setupEnv({}, {
      github: { 'Comfy-Org/ComfyUI': { 'ComfyUI_windows_portable_nvidia.7z': { bytes: blob(1000), publishedSha: 'f'.repeat(64) } } },
      hf: {}
    })
    const k = collect()
    await env.svc.start(['comfyui'], k.sink)
    expect((await k.done).failed).toEqual(['comfyui'])
    expect(k.progress.find((p) => p.phase === 'failed')?.message).toMatch(/checksum/)
  })

  it('explains a gated Hugging Face file instead of asking for a login', async () => {
    const env = await setupEnv()
    const k0 = collect()
    await env.svc.start(['comfyui'], k0.sink)
    await k0.done
    const k = collect()
    await env.svc.start(['flux-schnell'], k.sink)
    await k.done
    expect(k.progress.find((p) => p.phase === 'failed')?.message).toMatch(/needs a Hugging Face login/)
  })

  it('checks free space first', async () => {
    const env = await setupEnv({ freeBytes: async () => 5e9 })
    await expect(env.svc.start(['sdxl-base', 'gpt-oss-20b'], collect().sink)).rejects.toThrow(/only 5 GB is free/)
  })

  it('never installs programs in the Store build, and reports what is installed', async () => {
    const env = await setupEnv({ storeBuild: true })
    await expect(env.svc.start(['ollama-app'], collect().sink)).rejects.toThrow(/Microsoft Store version/)
    const st = await env.svc.status()
    expect(st.find((s) => s.id === 'ollama-app')?.state).toBe('installed') // the fake Ollama is running
    expect(st.find((s) => s.id === 'gpt-oss-20b')?.state).toBe('missing')
    expect(st.find((s) => s.id === 'sdxl-base')?.state).toBe('unknown')
  })

  it('every catalogued item has a licence and an official source', () => {
    for (const c of COMPONENTS) {
      expect(c.licence).toBeTruthy()
      expect(c.licenceUrl).toMatch(/^https:\/\//)
    }
    expect(COMPONENTS.find((c) => c.id === 'flux-schnell')!.recommended).toBe(false)
  })

  it('hashes files', async () => {
    const f = join(tmp(), 'x')
    writeFileSync(f, 'abc')
    expect(await sha256File(f)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
