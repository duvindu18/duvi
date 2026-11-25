import { app, BrowserWindow, clipboard, dialog, nativeTheme } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkUrl } from '@shared/net-policy'
import type { Settings } from '@shared/settings'
import type { DataStore } from './db/store'
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
  nativeTheme.themeSource = s.theme
}

export function createHandlers(ctx: Context): Handlers {
  const projects = () => ctx.data.projects()
  const ollama = new OllamaClient(() => ctx.settings.get().endpoints.ollama)
  const comfy = new ComfyClient(() => ctx.settings.get().endpoints.comfy)
  const alive = (p: Promise<unknown>) => p.then(() => true, () => false)

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
    }
  }
}
