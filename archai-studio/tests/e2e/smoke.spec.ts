import { expect, test } from '@playwright/test'
import { launchApp } from './launch'

test('app opens a locked-down window', async () => {
  const app = await launchApp()
  const page = await app.firstWindow()

  await expect(page.getByTestId('app-title')).toHaveText('ArchAI Studio')
  await expect(page.getByTestId('app-version')).toContainText('Electron')
  expect(page.url()).toBe('app://archai/index.html')

  // Security settings of the real window.
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    // getLastWebPreferences exists at runtime but is missing from Electron's typings.
    const wc = BrowserWindow.getAllWindows()[0]!.webContents as unknown as { getLastWebPreferences(): Electron.WebPreferences }
    const p = wc.getLastWebPreferences()
    return { ci: p.contextIsolation, ni: p.nodeIntegration, sb: p.sandbox, ws: p.webSecurity, wv: p.webviewTag }
  })
  expect(prefs).toEqual({ ci: true, ni: false, sb: true, ws: true, wv: false })

  // The screen sees no Node.js and only the two bridge functions.
  const surface = await page.evaluate(() => ({
    require: typeof (globalThis as { require?: unknown }).require,
    process: typeof (globalThis as { process?: unknown }).process,
    api: Object.keys(window.archai).sort(),
    frozen: Object.isFrozen(window.archai)
  }))
  expect(surface).toEqual({ require: 'undefined', process: 'undefined', api: ['invoke', 'on'], frozen: true })

  // Channels outside the allow-list are refused.
  const refused = await page.evaluate(() =>
    (window.archai.invoke as (c: string) => Promise<unknown>)('fs:readFile').then(() => 'resolved', (e: Error) => e.message)
  )
  expect(refused).toContain('Channel not allowed')

  // Bad payloads are refused by the main process.
  const bad = await page.evaluate(() => window.archai.invoke('net:probe', { url: 42 } as never))
  expect(bad.ok).toBe(false)

  // The screen cannot reach the network directly: CSP blocks it.
  const direct = await page.evaluate(() =>
    fetch('http://127.0.0.1:11434/api/tags').then(() => 'reached', () => 'blocked')
  )
  expect(direct).toBe('blocked')

  // CSP header is present on our pages.
  const csp = await page.evaluate(() => fetch('/index.html').then((r) => r.headers.get('content-security-policy')))
  expect(csp).toContain("connect-src 'self'")

  // Navigation away from the app is blocked.
  await page.evaluate(() => { window.location.href = 'https://example.com' })
  await page.waitForTimeout(300)
  expect(page.url()).toBe('app://archai/index.html')

  await app.close()
})
