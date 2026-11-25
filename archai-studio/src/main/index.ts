import { app, session } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loopbackPorts } from '@shared/settings'
import { buildCsp } from './csp'
import { openDatabase } from './db/database'
import { ProjectsRepo } from './db/projects-repo'
import { applyTheme, createHandlers } from './handlers'
import { registerIpc } from './ipc'
import { initLogFile, log } from './log'
import { setNetPolicy } from './net-guard'
import { DB_FILE, defaultDataDir, SETTINGS_FILE } from './paths'
import { APP_ORIGIN, handleAppProtocol, registerSchemesAsPrivileged } from './protocol'
import { SettingsStore } from './settings-store'
import { createMainWindow, rendererRoot } from './window'

// Test hook: isolate user data (used by Playwright so tests never touch real data).
if (process.env.ARCHAI_USER_DATA) app.setPath('userData', process.env.ARCHAI_USER_DATA)

const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const devServerOrigin = devServerUrl ? new URL(devServerUrl).origin : undefined
const here = dirname(fileURLToPath(import.meta.url))

registerSchemesAsPrivileged()

if (!app.requestSingleInstanceLock()) app.quit()

function lockDownSession(): void {
  const ses = session.defaultSession
  // The screen may only load our own files: block every other request at the session level.
  ses.webRequest.onBeforeRequest((details, cb) => {
    const u = details.url
    const ok =
      u.startsWith(`${APP_ORIGIN}/`) ||
      u.startsWith('devtools://') ||
      u.startsWith('data:') ||
      u.startsWith('blob:') ||
      u.startsWith('archai-img:') ||
      (devServerOrigin !== undefined && (u.startsWith(devServerOrigin) || u.startsWith(devServerOrigin.replace(/^http/, 'ws'))))
    if (!ok) log.warn(`blocked screen request to ${safeHost(u)}`)
    cb({ cancel: !ok })
  })
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
}

function safeHost(u: string): string {
  try {
    return new URL(u).host || u.slice(0, 40)
  } catch {
    return u.slice(0, 40)
  }
}

app.whenReady().then(() => {
  initLogFile(join(app.getPath('userData'), 'logs'))
  log.info(`ArchAI Studio ${app.getVersion()} starting`)

  const csp = buildCsp({ devServerOrigin })
  handleAppProtocol(rendererRoot(here), csp)
  lockDownSession()
  if (devServerOrigin) {
    session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
    })
  }

  const settings = new SettingsStore(join(app.getPath('userData'), SETTINGS_FILE), defaultDataDir(), (s) => {
    setNetPolicy({ loopbackPorts: loopbackPorts(s) })
    applyTheme(s)
  })
  const s = settings.get()
  setNetPolicy({ loopbackPorts: loopbackPorts(s) })
  applyTheme(s)

  const db = openDatabase(join(s.folders.data, DB_FILE))
  log.info(`data folder: ${s.folders.data}`)
  const projects = new ProjectsRepo(db)

  registerIpc(createHandlers({ settings, projects }), devServerOrigin)

  createMainWindow({
    preloadPath: join(here, '../preload/index.cjs'),
    devServerUrl,
    devTools: !app.isPackaged,
    dark: s.theme !== 'light'
  })

  app.on('will-quit', () => db.close())
})

app.on('window-all-closed', () => app.quit())
