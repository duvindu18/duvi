import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Launches the built app with an isolated, throwaway user-data folder. */
export async function launchApp(env: Record<string, string> = {}): Promise<ElectronApplication> {
  const userData = mkdtempSync(join(tmpdir(), 'archai-e2e-'))
  const args = ['out/main/index.js']
  // Containers run tests as root, where Chromium refuses its OS sandbox. CI and real PCs don't need this.
  if (process.getuid?.() === 0) args.unshift('--no-sandbox')
  return electron.launch({ args, env: { ...process.env, ARCHAI_USER_DATA: userData, ...env } as Record<string, string> })
}
