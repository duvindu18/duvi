/**
 * Settings live in a small JSON file in the app's own folder (%APPDATA%\ArchAI Studio),
 * which also records where your data folder is. Writes are atomic (temp file + rename)
 * so a crash can't leave a half-written file.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { applyPatch, defaultSettings, SettingsPatchSchema, SettingsSchema, type Settings } from '@shared/settings'

export class SettingsStore {
  private current: Settings

  constructor(
    private readonly file: string,
    dataDir: string,
    private readonly onChange: (s: Settings) => void = () => {}
  ) {
    this.current = this.load(dataDir)
  }

  private load(dataDir: string): Settings {
    const defaults = defaultSettings(dataDir)
    if (!existsSync(this.file)) return defaults
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      const parsed = SettingsSchema.safeParse(raw)
      if (parsed.success) return parsed.data
      // Keep whatever valid sections we can; fall back to defaults for the rest.
      return mergeLenient(defaults, raw)
    } catch {
      return defaults
    }
  }

  get(): Settings {
    return structuredClone(this.current)
  }

  set(patch: unknown): Settings {
    const p = SettingsPatchSchema.parse(patch)
    this.current = applyPatch(this.current, p)
    this.save()
    this.onChange(this.get())
    return this.get()
  }

  /** Replace from an imported file, keeping this PC's folders if the file's are unusable. */
  importFrom(raw: unknown, keepFolders: boolean): Settings {
    const merged = mergeLenient(this.current, raw)
    this.current = keepFolders ? { ...merged, folders: this.current.folders } : merged
    this.current.activeProjectId = null
    this.save()
    this.onChange(this.get())
    return this.get()
  }

  save(): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.current, null, 2), 'utf8')
    renameSync(tmp, this.file)
  }
}

/** Applies each top-level section of raw that validates on its own; ignores the rest. */
export function mergeLenient(base: Settings, raw: unknown): Settings {
  if (!raw || typeof raw !== 'object') return base
  let out = base
  const r = raw as Record<string, unknown>
  for (const key of Object.keys(SettingsPatchSchema.shape) as (keyof typeof SettingsPatchSchema.shape)[]) {
    if (!(key in r)) continue
    const one = SettingsPatchSchema.safeParse({ [key]: r[key] })
    if (!one.success) continue
    try {
      out = applyPatch(out, one.data)
    } catch {
      /* section invalid in combination; skip */
    }
  }
  return out
}
