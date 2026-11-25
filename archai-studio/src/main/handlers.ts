import { app, BrowserWindow, clipboard, dialog, nativeImage, nativeTheme, shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { checkUrl } from '@shared/net-policy'
import type { Settings } from '@shared/settings'
import type { DataStore } from './db/store'
import { ChatService, type ChatSink } from './features/chat'
import { explainMessage, fixMessage, generateMessage, scriptSystemPrompt } from './features/scripts'
import { TARGETS, scriptFileName } from '@shared/scripts'
import { checkBindings, describeWorkflow, detectBindings, guessMode, parseApiWorkflow, type ApiWorkflow } from '@shared/images'
import { ImagesService, toGallery, type InputImage } from './features/images'
import { handleImageProtocol } from './protocol'
import { GpuCoordinator } from './services/gpu'
import type { Handlers } from './ipc'
import { freeBytesFor, runChecks, runNvidiaSmi } from './services/checks'
import { ComfyClient } from './services/comfy'
import { OllamaClient } from './services/ollama'
import { getNetPolicy } from './net-guard'
import type { SettingsStore } from './settings-store'

export interface Context {
  settings: SettingsStore
  data: DataStore
}

const parentWindow = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]

export function applyTheme(s: Settings): void {
  // Window frame and native dialogs follow the theme; Phthalo is a dark theme.
  nativeTheme.themeSource = s.theme === 'phthalo' ? 'dark' : s.theme
}

export function createHandlers(ctx: Context): Handlers {
  const projects = () => ctx.data.projects()
  const ollama = new OllamaClient(() => ctx.settings.get().endpoints.ollama)
  const comfy = new ComfyClient(() => ctx.settings.get().endpoints.comfy)
  const alive = (p: Promise<unknown>) => p.then(() => true, () => false)
  const broadcast = <T>(channel: string, payload: T) => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
  const gpu = new GpuCoordinator(() => ctx.settings.get().gpu.turnTaking, ollama, comfy, (o) => broadcast('gpu:state', o))
  const sinkFor = (event: IpcMainInvokeEvent): ChatSink => {
    const send = <T>(ch: string, p: T) => {
      if (!event.sender.isDestroyed()) event.sender.send(ch, p)
    }
    return { chunk: (c) => send('chat:chunk', c), done: (d) => send('chat:done', d), error: (e) => send('chat:error', e) }
  }
  // Input images the user picked this session (token -> file). The screen only ever sees tokens.
  const inputs = new Map<string, InputImage>()
  const pendingImports = new Map<string, ApiWorkflow>()
  const dataFolder = () => ctx.data.openFolder() ?? ctx.settings.get().folders.data
  const images = new ImagesService({
    comfy,
    ollama,
    gpu,
    repo: () => ctx.data.images(),
    projects,
    galleryDir: () => ctx.settings.get().folders.gallery ?? join(dataFolder(), 'Gallery'),
    input: (ref) => {
      if ('token' in ref) return inputs.get(ref.token) ?? null
      const row = ctx.data.images().get(ref.imageId)
      return row ? { path: row.path, name: row.path.split(/[\\/]/).pop() ?? 'image.png', width: row.width ?? 1024, height: row.height ?? 1024 } : null
    },
    helperModel: () => ctx.settings.get().models.chat,
    numCtx: () => ctx.settings.get().chat.contextLength
  })
  handleImageProtocol((kind, key) => {
    if (kind === 'gallery') return ctx.data.images().get(Number(key))?.path ?? null
    if (kind === 'input') return inputs.get(key)?.path ?? null
    return null
  })
  const imageSink = (event: IpcMainInvokeEvent) => {
    const send = <T>(ch: string, p: T) => {
      if (!event.sender.isDestroyed()) event.sender.send(ch, p)
    }
    return { progress: (p: unknown) => send('images:progress', p), done: (d: unknown) => send('images:done', d), error: (e: unknown) => send('images:error', e) }
  }

  const chat = new ChatService({
    ollama,
    chats: () => ctx.data.chats(),
    projects,
    gpu,
    numCtx: () => ctx.settings.get().chat.contextLength
  })

  return {
    'app:info': () => ({
      name: app.getName(),
      version: app.getVersion(),
      buildType: !app.isPackaged ? 'dev' : process.windowsStore ? 'store' : 'exe',
      platform: process.platform,
      electron: process.versions.electron,
      userData: app.getPath('userData')
    }),

    'net:probe': ({ url }) => {
      const v = checkUrl(url, 'local-ai', getNetPolicy())
      return { url, allowed: v.allowed, reason: v.reason }
    },

    'settings:get': () => ctx.settings.get(),
    'settings:set': (patch) => {
      if (patch.activeProjectId != null && !projects().get(patch.activeProjectId)) throw new Error('That project no longer exists.')
      return ctx.settings.set(patch)
    },

    'settings:export': async () => {
      const win = parentWindow()
      const opts = { title: 'Export settings', defaultPath: join(app.getPath('documents'), 'ArchAI Studio settings.json'), filters: [{ name: 'Settings', extensions: ['json'] }] }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return { done: false }
      const { activeProjectId: _a, ...portable } = ctx.settings.get()
      writeFileSync(r.filePath, JSON.stringify({ ...portable, exportedBy: 'ArchAI Studio' }, null, 2), 'utf8')
      return { done: true, path: r.filePath }
    },

    'settings:import': async () => {
      const win = parentWindow()
      const opts = { title: 'Import settings', properties: ['openFile' as const], filters: [{ name: 'Settings', extensions: ['json'] }] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const file = r.filePaths[0]
      if (r.canceled || !file) return { done: false }
      if (statSync(file).size > 1_000_000) throw new Error('That file is too large to be a settings file.')
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        throw new Error('That file is not valid JSON. Choose a file exported from ArchAI Studio.')
      }
      // Folders are specific to each PC, so this PC's folders are kept.
      const settings = ctx.settings.importFrom(raw, true)
      return { done: true, path: file, settings }
    },

    'dialog:pickFolder': async ({ title, defaultPath }) => {
      const win = parentWindow()
      const opts = { title, defaultPath, properties: ['openDirectory' as const, 'createDirectory' as const] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const dir = r.filePaths[0]
      return r.canceled || !dir ? { done: false } : { done: true, path: dir }
    },

    'projects:list': (req) => projects().list(req?.includeArchived ?? false),
    'projects:create': ({ name }) => {
      const p = projects().create(name)
      ctx.settings.set({ activeProjectId: p.id })
      return p
    },
    'projects:rename': ({ id, name }) => projects().rename(id, name),
    'projects:archive': ({ id, archived }) => {
      const p = projects().setArchived(id, archived)
      if (archived && ctx.settings.get().activeProjectId === id) {
        ctx.settings.set({ activeProjectId: projects().list()[0]?.id ?? null })
      }
      return p
    },

    'checks:run': () =>
      runChecks(ctx.settings.get(), {
        ollama,
        comfy,
        nvidiaSmi: runNvidiaSmi,
        electronGpus: async () => {
          const info = (await app.getGPUInfo('basic')) as { gpuDevice?: { vendorId: number; deviceString?: string }[] }
          return (info.gpuDevice ?? []).map((g) => ({ vendorId: g.vendorId, name: g.deviceString }))
        },
        freeBytes: freeBytesFor
      }),

    'services:ping': async () => {
      const [o, c] = await Promise.all([alive(ollama.version(1500)), alive(comfy.systemStats(1500))])
      return { ollama: o, comfy: c }
    },

    'disk:free': async ({ path }) => ({ bytes: await freeBytesFor(path) }),

    'clipboard:writeText': ({ text }) => {
      clipboard.writeText(text)
      return true
    },

    'chat:models': async () => {
      let models
      try {
        models = await ollama.tags(4000)
      } catch {
        throw new Error("Ollama isn't running, so the model list is empty. Start Ollama, then try again.")
      }
      return models
        .filter((m) => !/embed/i.test(m.name))
        .map((m) => ({
          name: m.name,
          sizeGb: m.size ? Math.round((m.size / 1024 ** 3) * 10) / 10 : null,
          parameters: m.details?.parameter_size ?? null,
          quantization: m.details?.quantization_level ?? null
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    },
    'chat:threads': ({ projectId }) => ctx.data.chats().threads(projectId),
    'chat:history': ({ threadId }) => ctx.data.chats().messages(threadId),
    'chat:send': (req, event) => chat.send(req, sinkFor(event)),
    'chat:cancel': ({ streamId }) => chat.cancel(streamId),
    'chat:renameThread': ({ threadId, title }) => ctx.data.chats().rename(threadId, title),
    'gpu:get': () => gpu.current(),

    'scripts:generate': (r, event) =>
      chat.send({ projectId: r.projectId, threadId: r.threadId, model: r.model, text: generateMessage(r.target, r.task) }, sinkFor(event), {
        base: scriptSystemPrompt(r.target),
        kind: 'script',
        title: r.task
      }),
    'scripts:explain': (r, event) =>
      chat.send({ projectId: r.projectId, threadId: r.threadId, model: r.model, text: explainMessage(r.target, r.code) }, sinkFor(event), {
        base: scriptSystemPrompt(r.target),
        kind: 'script',
        title: `Explain ${TARGETS[r.target].name} script`
      }),
    'scripts:fix': (r, event) =>
      chat.send({ projectId: r.projectId, threadId: r.threadId, model: r.model, text: fixMessage(r.target, r.code, r.error) }, sinkFor(event), {
        base: scriptSystemPrompt(r.target),
        kind: 'script',
        title: `Fix ${TARGETS[r.target].name} script`
      }),
    'scripts:save': async ({ projectId, target, title, code }) => {
      const t = TARGETS[target]
      const win = parentWindow()
      const opts = {
        title: 'Save script',
        defaultPath: join(app.getPath('documents'), scriptFileName(title, t.ext)),
        filters: [{ name: `${t.name} script`, extensions: [t.ext] }]
      }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return { done: false }
      // Scripts are saved as UTF-8 with Windows line endings; AutoLISP and Revit both read this fine.
      writeFileSync(r.filePath, code.replace(/\r?\n/g, '\r\n'), 'utf8')
      return { done: true, script: ctx.data.scripts().add(projectId, target, title, code, r.filePath) }
    },
    'scripts:list': ({ projectId }) => ctx.data.scripts().list(projectId),

    'images:workflows': () => images.workflows().map(({ json: _j, ...w }) => w),
    'images:importWorkflow': async () => {
      const win = parentWindow()
      const opts = { title: 'Import a ComfyUI workflow (API format)', properties: ['openFile' as const], filters: [{ name: 'ComfyUI workflow', extensions: ['json'] }] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const file = r.filePaths[0]
      if (r.canceled || !file) return null
      if (statSync(file).size > 5_000_000) throw new Error('That file is too large to be a workflow.')
      let raw: unknown
      try {
        raw = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        throw new Error('That file is not valid JSON.')
      }
      const wf = parseApiWorkflow(raw) // explains the editor-vs-API format problem
      const bindings = detectBindings(wf)
      const mode = guessMode(bindings, wf)
      const token = randomUUID()
      pendingImports.set(token, wf)
      return {
        token,
        name: (file.split(/[\\/]/).pop() ?? 'Workflow').replace(/\.json$/i, ''),
        mode,
        bindings,
        nodes: Object.entries(wf).map(([id, n]) => ({ id, classType: n.class_type, inputs: Object.keys(n.inputs) })),
        problems: checkBindings(wf, bindings, mode)
      }
    },
    'images:saveWorkflow': ({ token, name, mode, bindings }) => {
      const wf = pendingImports.get(token)
      if (!wf) throw new Error('Import the workflow again.')
      const problems = checkBindings(wf, bindings, mode)
      if (problems.length) throw new Error(problems[0])
      const id = `user-${randomUUID().slice(0, 8)}`
      ctx.data.images().addWorkflow(id, name, mode, 'Imported from ComfyUI', wf, bindings)
      pendingImports.delete(token)
      return { id, name, mode, description: 'Imported from ComfyUI', builtIn: false, bindings, ...describeWorkflow(wf, bindings) }
    },
    'images:models': () => comfy.models(),
    'images:promptHelp': ({ description, preset, mode, family }) => images.promptHelp(description, preset, mode, family),
    'images:pickInput': async () => {
      const win = parentWindow()
      const opts = { title: 'Choose a sketch, screenshot or image', properties: ['openFile' as const], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] }
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const file = r.filePaths[0]
      if (r.canceled || !file) return null
      if (statSync(file).size > 40_000_000) throw new Error('That image is larger than 40 MB. Save a smaller copy first.')
      const size = nativeImage.createFromPath(file).getSize()
      if (!size.width) throw new Error("That file couldn't be read as an image. Use a PNG or JPEG.")
      const token = randomUUID()
      const name = file.split(/[\\/]/).pop() ?? 'image'
      inputs.set(token, { path: file, name, width: size.width, height: size.height })
      return { token, name, width: size.width, height: size.height, url: `archai-img://input/${token}` }
    },
    'images:generate': (req, event) => images.generate(req, imageSink(event) as never),
    'images:cancel': ({ jobId }) => images.cancel(jobId),
    'gallery:list': ({ projectId }) => ctx.data.images().list(projectId).map(toGallery),
    'gallery:reveal': ({ id }) => {
      const row = ctx.data.images().get(id)
      if (!row) throw new Error('That image is no longer in the gallery.')
      shell.showItemInFolder(row.path)
      return true as const
    },
    'gallery:trash': async ({ id }) => {
      const row = ctx.data.images().get(id)
      if (!row) throw new Error('That image is no longer in the gallery.')
      // Recycle Bin, not permanent deletion, so it can be restored.
      await shell.trashItem(row.path).catch(() => undefined)
      ctx.data.images().markTrashed(id)
      return true as const
    }
  }
}
