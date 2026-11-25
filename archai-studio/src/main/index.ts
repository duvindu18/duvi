import { app, session } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loopbackPorts } from '@shared/settings'
import { buildCsp } from './csp'
import { DataStore } from './db/store'
import { applyTheme, createHandlers } from './handlers'
import { registerIpc } from './ipc'
import { initLogFile, log } from './log'
import { setNetPolicy } from './net-guard'
import { defaultDataDir, SETTINGS_FILE } from './paths'
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

  // The data folder in use is fixed for this session; a change in Settings applies on next start.
  const dataDir = s.folders.data
  const data = new DataStore(() => (s.firstRunComplete ? dataDir : settings.get().folders.data))
  log.info(`data folder: ${dataDir}`)

  registerIpc(createHandlers({ settings, data }), devServerOrigin)

  createMainWindow({
    preloadPath: join(here, '../preload/index.cjs'),
    devServerUrl,
    devTools: !app.isPackaged,
    background: s.theme === 'light' ? '#F0EEE9' : s.theme === 'phthalo' ? '#123524' : '#1B1C1A'
  })

  app.on('will-quit', () => data.close())
})

app.on('window-all-closed', () => app.quit())
