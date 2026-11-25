import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Default data folder: C:\Users\<you>\ArchAI Studio (on the NVMe system drive).
 * Tests and power users can override it with ARCHAI_DATA_DIR.
 */
export function defaultDataDir(): string {
  return process.env.ARCHAI_DATA_DIR || join(homedir(), 'ArchAI Studio')
}

export const DB_FILE = 'archai.db'
export const SETTINGS_FILE = 'settings.json'
