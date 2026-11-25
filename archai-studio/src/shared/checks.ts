export type CheckId = 'ollama' | 'model' | 'comfy' | 'gpu' | 'disk'
export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface CheckFix {
  /** Plain-language instructions. */
  text: string
  /** A command to copy into PowerShell, if there is one. */
  command?: string
  /** A web page with more help (opens in your browser only when clicked). */
  link?: { label: string; url: string }
}

export interface CheckResult {
  id: CheckId
  status: CheckStatus
  title: string
  detail: string
  fix?: CheckFix
}

export interface ServicePing {
  ollama: boolean
  comfy: boolean
}

/** "nomic-embed-text" matches "nomic-embed-text:latest"; otherwise names must match exactly. */
export function hasModel(installed: string[], wanted: string): boolean {
  const w = wanted.trim().toLowerCase()
  return installed.some((n) => {
    const m = n.toLowerCase()
    return m === w || (!w.includes(':') && m === `${w}:latest`)
  })
}

export const GB = 1024 ** 3
export const DISK_WARN_BYTES = 20 * GB
export const DISK_FAIL_BYTES = 5 * GB
