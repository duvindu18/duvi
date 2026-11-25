/**
 * Local-only log file (<app folder>\logs\archai.log, rotated at 1 MB).
 * Nothing is ever sent anywhere.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

let logFile: string | null = null

export function initLogFile(dir: string): void {
  mkdirSync(dir, { recursive: true })
  logFile = join(dir, 'archai.log')
  try {
    if (existsSync(logFile) && statSync(logFile).size > 1_000_000) renameSync(logFile, join(dir, 'archai.old.log'))
  } catch {
    /* ignore */
  }
}

function write(level: string, msg: string): void {
  const line = `${new Date().toISOString()} ${level} ${msg}`
  if (level === 'ERROR' || level === 'WARN') console.warn(`[archai] ${msg}`)
  else console.log(`[archai] ${msg}`)
  if (logFile) {
    try {
      appendFileSync(logFile, line + '\n')
    } catch {
      /* disk full or locked; keep running */
    }
  }
}

export const log = {
  info: (msg: string) => write('INFO', msg),
  warn: (msg: string) => write('WARN', msg),
  error: (msg: string, err?: unknown) => write('ERROR', `${msg} ${err instanceof Error ? err.message : (err ?? '')}`)
}
