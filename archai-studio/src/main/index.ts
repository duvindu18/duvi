import { app, session } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCsp } from './csp'
import { registerIpc } from './ipc'
import { log } from './log'
import { checkUrl } from '@shared/net-policy'
import { getNetPolicy } from './net-guard'
import { APP_ORIGIN, handleAppProtocol, registerSchemesAsPrivileged } from './protocol'
import { createMainWindow, rendererRoot } from './window'

// Test hook: isolate user data (used by Playwright so tests never touch real data).
if (process.env.ARCHAI_USER_DATA) app.setPath('userData', process.env.ARCHAI_USER_DATA)

const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const devServerOrigin = devServerUrl ? new URL(devServerUrl).origin : undefined

const here = dirname(fileURLToPath(import.meta.url))

registerSchemesAsPrivileged()

if (!app.requestSingleInstanceLock()) app.quit()

app.whenReady().then(() => {
  const csp = buildCsp({ devServerOrigin })
  handleAppProtocol(rendererRoot(here), csp)

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
    if (!ok) log.warn(`blocked screen request to ${new URL(u).host || u.slice(0, 40)}`)
    cb({ cancel: !ok })
  })
  if (devServerOrigin) {
    ses.webRequest.onHeadersReceived((details, cb) => {
      cb({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } })
    })
  }
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)

  registerIpc(
    {
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
      }
    },
    devServerOrigin
  )

  createMainWindow({
    preloadPath: join(here, '../preload/index.cjs'),
    devServerUrl,
    devTools: !app.isPackaged
  })
})

app.on('window-all-closed', () => app.quit())
