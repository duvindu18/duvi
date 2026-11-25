import { useEffect, useState, type ReactNode } from 'react'
import type { Project } from '@shared/projects'
import { CONTEXT_VRAM_WARNING, type Settings, type SettingsPatch } from '@shared/settings'
import { call, errorText } from '../lib/ipc'
import { useApp } from '../state/AppState'
import { SetupChecksPanel } from './Setup'

function Group({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="group" aria-labelledby={`g-${title}`}>
      <div>
        <h2 className="group__title" id={`g-${title}`}>{title}</h2>
        {desc && <p className="group__desc">{desc}</p>}
      </div>
      <div className="group__body">{children}</div>
    </section>
  )
}

/** A text setting that saves when you press Enter or leave the field. */
function TextSetting(props: {
  label: string
  hint?: string
  value: string
  toPatch: (v: string) => SettingsPatch
  testId: string
  inputMode?: 'numeric' | 'text'
  warn?: (v: string) => string | null
}) {
  const { replaceSettings, notify } = useApp()
  const [v, setV] = useState(props.value)
  const [error, setError] = useState<string | null>(null)
  // Pick up changes made elsewhere (e.g. settings import) without an effect.
  const [shown, setShown] = useState(props.value)
  if (shown !== props.value) {
    setShown(props.value)
    setV(props.value)
  }

  const commit = async () => {
    if (v === props.value) return
    try {
      replaceSettings(await call('settings:set', props.toPatch(v)))
      setError(null)
      notify('Settings saved')
    } catch (e) {
      setError(friendly(errorText(e)))
    }
  }
  const warning = props.warn?.(v) ?? null
  return (
    <label className="field">
      <span className="field__label">{props.label}</span>
      <input
        className="input"
        value={v}
        inputMode={props.inputMode}
        aria-invalid={error ? true : undefined}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => e.key === 'Enter' && void commit()}
        data-testid={props.testId}
      />
      {props.hint && !error && <span className="field__hint">{props.hint}</span>}
      {error && <span className="field__error" role="alert">{error}</span>}
      {warning && !error && <span className="field__warn">{warning}</span>}
    </label>
  )
}

/** Turns schema messages into plain language. */
function friendly(msg: string): string {
  if (/expected number|Invalid input/i.test(msg) && !/computer/.test(msg)) return 'Enter a whole number.'
  if (/Too small|>=2048/i.test(msg)) return 'Use at least 2048.'
  if (/Too big|<=131072/i.test(msg)) return 'Use 131072 or less.'
  return msg
}

export function SettingsPage() {
  const { settings, info } = useApp()
  if (!settings) return null
  return (
    <>
      <header className="page-head">
        <h1 className="page-title">Settings</h1>
      </header>
      <div className="settings">
        <Appearance settings={settings} />
        <Projects />
        <Services settings={settings} />
        <Group title="Setup checks" desc="Checks Ollama, the chat model, ComfyUI, your graphics card and free space.">
          <SetupChecksPanel />
        </Group>
        <Gpu settings={settings} />
        <Folders settings={settings} />
        <Backup />
        <Group title="About">
          <p className="field__hint">
            ArchAI Studio {info?.version} ({info?.buildType} build, Electron {info?.electron}). Everything runs on this computer. Nothing is sent to
            the internet, and no usage data is collected.
          </p>
        </Group>
      </div>
    </>
  )
}

function Appearance({ settings }: { settings: Settings }) {
  const { updateSettings } = useApp()
  const opts: { id: Settings['theme']; label: string }[] = [
    { id: 'dark', label: 'Dark' },
    { id: 'light', label: 'Light' },
    { id: 'phthalo', label: 'Phthalo' },
    { id: 'system', label: 'Match Windows' }
  ]
  return (
    <Group title="Appearance" desc="Phthalo uses the Seedform colours: a deep green ground with sand accents.">
      <div className="field">
        <span className="field__label" id="theme-label">Theme</span>
        <div className="segmented" role="group" aria-labelledby="theme-label">
          {opts.map((o) => (
            <button key={o.id} type="button" aria-pressed={settings.theme === o.id} onClick={() => void updateSettings({ theme: o.id })} data-testid={`theme-${o.id}`}>
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </Group>
  )
}

function Projects() {
  const { refreshProjects, notify, settings, replaceSettings } = useApp()
  const [all, setAll] = useState<Project[]>([])
  const [showArchived, setShowArchived] = useState(false)
  const [editing, setEditing] = useState<number | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const load = async () => setAll(await call('projects:list', { includeArchived: true }))
  useEffect(() => {
    let live = true
    void call('projects:list', { includeArchived: true }).then((list) => live && setAll(list))
    return () => {
      live = false
    }
  }, [settings?.activeProjectId])

  const after = async (msg: string) => {
    await Promise.all([load(), refreshProjects()])
    replaceSettings(await call('settings:get'))
    notify(msg)
  }
  const rename = async (p: Project) => {
    try {
      await call('projects:rename', { id: p.id, name })
      setEditing(null)
      setError(null)
      await after('Project renamed')
    } catch (e) {
      setError(errorText(e))
    }
  }
  const archive = async (p: Project, archived: boolean) => {
    try {
      await call('projects:archive', { id: p.id, archived })
      await after(archived ? `Archived ${p.name}` : `Restored ${p.name}`)
    } catch (e) {
      notify(errorText(e), true)
    }
  }
  const visible = all.filter((p) => showArchived || !p.archived)
  return (
    <Group title="Projects" desc="Archiving hides a project from the list. Nothing is deleted.">
      <ul className="plist" data-testid="project-list">
        {visible.length === 0 && <li className="plist__empty">No projects yet.</li>}
        {visible.map((p) =>
          editing === p.id ? (
            <li key={p.id}>
              <form
                className="row"
                style={{ flex: 1 }}
                onSubmit={(e) => {
                  e.preventDefault()
                  void rename(p)
                }}
              >
                <input className="input" value={name} autoFocus maxLength={120} aria-label="New name" aria-invalid={error ? true : undefined} onChange={(e) => setName(e.target.value)} data-testid="rename-input" />
                <button className="btn btn--primary" type="submit">Save</button>
                <button className="btn btn--quiet" type="button" onClick={() => { setEditing(null); setError(null) }}>Cancel</button>
              </form>
            </li>
          ) : (
            <li key={p.id}>
              <span className={`plist__name${p.archived ? ' plist__name--archived' : ''}`}>
                {p.name}
                {p.archived && ' (archived)'}
              </span>
              {!p.archived && (
                <button className="btn btn--quiet" type="button" onClick={() => { setEditing(p.id); setName(p.name); setError(null) }}>Rename</button>
              )}
              <button className="btn btn--quiet" type="button" onClick={() => void archive(p, !p.archived)}>
                {p.archived ? 'Restore' : 'Archive'}
              </button>
            </li>
          )
        )}
      </ul>
      {error && <span className="field__error" role="alert">{error}</span>}
      <label className="switch">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        <span>Show archived projects</span>
      </label>
    </Group>
  )
}

function Services({ settings }: { settings: Settings }) {
  return (
    <Group title="AI services" desc="Ollama and ComfyUI run on this computer. Only addresses on this computer are accepted.">
      <TextSetting label="Ollama address" value={settings.endpoints.ollama} toPatch={(v) => ({ endpoints: { ollama: v } })} testId="set-ollama" hint="Usually http://127.0.0.1:11434" />
      <TextSetting label="ComfyUI address" value={settings.endpoints.comfy} toPatch={(v) => ({ endpoints: { comfy: v } })} testId="set-comfy" hint="Usually http://127.0.0.1:8188" />
      <TextSetting label="Chat model" value={settings.models.chat} toPatch={(v) => ({ models: { chat: v } })} testId="set-model-chat" hint="Name as shown by “ollama list”. A picker arrives with Chat." />
      <TextSetting label="Script model" value={settings.models.scripts} toPatch={(v) => ({ models: { scripts: v } })} testId="set-model-scripts" />
      <TextSetting label="Embedding model" value={settings.models.embed} toPatch={(v) => ({ models: { embed: v } })} testId="set-model-embed" hint="Used for Documents (phase 2)." />
      <TextSetting
        label="Context length"
        inputMode="numeric"
        value={String(settings.chat.contextLength)}
        toPatch={(v) => ({ chat: { contextLength: Number(v.trim()) } })}
        testId="set-context"
        hint="How much text the model can keep in mind at once, in tokens. 8192 is a safe default."
        warn={(v) =>
          Number(v) > CONTEXT_VRAM_WARNING
            ? 'Above 16384 the model may not fit in your 16 GB of video memory. Replies can become much slower.'
            : null
        }
      />
    </Group>
  )
}

function Gpu({ settings }: { settings: Settings }) {
  const { updateSettings } = useApp()
  return (
    <Group title="Video memory" desc="gpt-oss:20b and image models each need most of your 16 GB of video memory.">
      <label className="switch">
        <input type="checkbox" checked={settings.gpu.turnTaking} onChange={(e) => void updateSettings({ gpu: { turnTaking: e.target.checked } })} data-testid="set-turntaking" />
        <span>
          Take turns on the GPU
          <span className="field__hint" style={{ display: 'block' }}>
            Unloads the chat model before rendering images, and frees ComfyUI's memory before chatting. Turn off only if you use smaller models that fit together.
          </span>
        </span>
      </label>
    </Group>
  )
}

function Folders({ settings }: { settings: Settings }) {
  const { updateSettings } = useApp()
  const pick = async (which: 'data' | 'gallery') => {
    const r = await call('dialog:pickFolder', {
      title: which === 'data' ? 'Choose the data folder' : 'Choose the image gallery folder',
      defaultPath: which === 'data' ? settings.folders.data : (settings.folders.gallery ?? undefined)
    })
    if (r.done) await updateSettings({ folders: { [which]: r.path } })
  }
  return (
    <Group title="Folders" desc="Where your projects, chats and images are kept. A change to the data folder takes effect the next time you open the app.">
      <div className="field">
        <span className="field__label">Data folder</span>
        <div className="row">
          <span className="path" title={settings.folders.data} data-testid="data-folder">{settings.folders.data}</span>
          <button className="btn" type="button" onClick={() => void pick('data')}>Choose…</button>
        </div>
        <span className="field__hint">Keep this on your fast NVMe drive (C:). Files already there are not moved.</span>
      </div>
      <div className="field">
        <span className="field__label">Image gallery folder</span>
        <div className="row">
          <span className={`path${settings.folders.gallery ? '' : ' path--none'}`}>{settings.folders.gallery ?? 'Inside the data folder'}</span>
          <button className="btn" type="button" onClick={() => void pick('gallery')}>Choose…</button>
          {settings.folders.gallery && (
            <button className="btn btn--quiet" type="button" onClick={() => void updateSettings({ folders: { gallery: null } })}>Use data folder</button>
          )}
        </div>
        <span className="field__hint">Renders take a lot of space. You can keep them on the 2 TB D: drive.</span>
      </div>
    </Group>
  )
}

function Backup() {
  const { notify, replaceSettings } = useApp()
  const exp = async () => {
    try {
      const r = await call('settings:export')
      if (r.done) notify(`Settings exported to ${r.path}`)
    } catch (e) {
      notify(errorText(e), true)
    }
  }
  const imp = async () => {
    try {
      const r = await call('settings:import')
      if (r.done && r.settings) {
        replaceSettings(r.settings)
        notify('Settings imported. Folders on this computer were kept.')
      }
    } catch (e) {
      notify(errorText(e), true)
    }
  }
  return (
    <Group title="Back up settings" desc="Save your settings to a file, or load them on another computer. Projects and chats are not included.">
      <div className="row">
        <button className="btn" type="button" onClick={() => void exp()} data-testid="settings-export">Export settings…</button>
        <button className="btn" type="button" onClick={() => void imp()} data-testid="settings-import">Import settings…</button>
      </div>
    </Group>
  )
}
