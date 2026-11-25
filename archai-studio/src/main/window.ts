import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { APP_ORIGIN, isAppUrl } from './protocol'

export function createMainWindow(opts: { preloadPath: string; devServerUrl?: string; devTools: boolean }): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: '#141414',
    title: 'ArchAI Studio',
    autoHideMenuBar: true,
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
      devTools: opts.devTools
    }
  })

  const devOrigin = opts.devServerUrl ? new URL(opts.devServerUrl).origin : undefined

  // No popups; https links open in the user's browser (only from explicit clicks).
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url, devOrigin)) e.preventDefault()
  })
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())
  win.once('ready-to-show', () => win.show())

  if (opts.devServerUrl) void win.loadURL(opts.devServerUrl)
  else void win.loadURL(`${APP_ORIGIN}/index.html`)
  return win
}

export function rendererRoot(mainDir: string): string {
  return join(mainDir, '../renderer')
}
