import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Launches the built app with an isolated, throwaway user-data folder. */
export async function launchApp(env: Record<string, string> = {}, dirs?: { userData: string; data: string }): Promise<ElectronApplication> {
  const root = mkdtempSync(join(tmpdir(), 'archai-e2e-'))
  const userData = dirs?.userData ?? join(root, 'userData')
  const data = dirs?.data ?? join(root, 'data')
  // Launch the app folder (not the script) so Electron reads package.json for the name and version.
  const args = ['.']
  // Containers run tests as root, where Chromium refuses its OS sandbox. CI and real PCs don't need this.
  if (process.getuid?.() === 0) args.unshift('--no-sandbox')
  return electron.launch({ args, env: { ...process.env, ARCHAI_USER_DATA: userData, ARCHAI_DATA_DIR: data, ...env } as Record<string, string> })
}
