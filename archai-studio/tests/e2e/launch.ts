import { _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface Dirs {
  root: string
  userData: string
  data: string
}

export function makeDirs(): Dirs {
  const root = mkdtempSync(join(tmpdir(), 'archai-e2e-'))
  return { root, userData: join(root, 'userData'), data: join(root, 'data') }
}

/**
 * Launches the built app with throwaway folders. `seed` is written as settings.json
 * before start. By default setup counts as already done, so tests start in the app.
 */
export async function launchApp(opts: { dirs?: Dirs; seed?: Record<string, unknown> | null } = {}): Promise<ElectronApplication> {
  const d = opts.dirs ?? makeDirs()
  const seed = opts.seed === undefined ? { firstRunComplete: true } : opts.seed
  if (seed) {
    mkdirSync(d.userData, { recursive: true })
    writeFileSync(join(d.userData, 'settings.json'), JSON.stringify(seed))
  }
  // Launch the app folder (not the script) so Electron reads package.json for the name and version.
  const args = ['.']
  // Containers run tests as root, where Chromium refuses its OS sandbox. CI and real PCs don't need this.
  if (process.getuid?.() === 0) args.unshift('--no-sandbox')
  return electron.launch({ args, env: { ...process.env, ARCHAI_USER_DATA: d.userData, ARCHAI_DATA_DIR: d.data } as Record<string, string> })
}
