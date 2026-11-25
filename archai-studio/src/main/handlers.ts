import { app, BrowserWindow, dialog, nativeTheme } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkUrl } from '@shared/net-policy'
import type { Settings } from '@shared/settings'
import type { ProjectsRepo } from './db/projects-repo'
import type { Handlers } from './ipc'
import { getNetPolicy } from './net-guard'
import type { SettingsStore } from './settings-store'

export interface Context {
  settings: SettingsStore
  projects: ProjectsRepo
}

const parentWindow = () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]

export function applyTheme(s: Settings): void {
  nativeTheme.themeSource = s.theme
}

export function createHandlers(ctx: Context): Handlers {
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
      if (patch.activeProjectId != null && !ctx.projects.get(patch.activeProjectId)) throw new Error('That project no longer exists.')
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

    'projects:list': (req) => ctx.projects.list(req?.includeArchived ?? false),
    'projects:create': ({ name }) => {
      const p = ctx.projects.create(name)
      ctx.settings.set({ activeProjectId: p.id })
      return p
    },
    'projects:rename': ({ id, name }) => ctx.projects.rename(id, name),
    'projects:archive': ({ id, archived }) => {
      const p = ctx.projects.setArchived(id, archived)
      if (archived && ctx.settings.get().activeProjectId === id) {
        ctx.settings.set({ activeProjectId: ctx.projects.list()[0]?.id ?? null })
      }
      return p
    }
  }
}
