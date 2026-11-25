import { app, BrowserWindow, clipboard, dialog, nativeTheme } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { checkUrl } from '@shared/net-policy'
import type { Settings } from '@shared/settings'
import type { DataStore } from './db/store'
import { ChatService, type ChatSink } from './features/chat'
import { explainMessage, fixMessage, generateMessage, scriptSystemPrompt } from './features/scripts'
import { TARGETS, scriptFileName } from '@shared/scripts'
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
    'scripts:list': ({ projectId }) => ctx.data.scripts().list(projectId)
  }
}
