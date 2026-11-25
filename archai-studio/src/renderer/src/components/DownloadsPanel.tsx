import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { COMPONENTS, formatBytes, type ComponentId, type ComponentStatus, type DownloadProgress } from '@shared/downloads'
import { call, errorText } from '../lib/ipc'
import { useApp } from '../state/AppState'

const OFFICIAL: Partial<Record<ComponentId, string>> = {
  'ollama-app': 'https://ollama.com/download/windows',
  comfyui: 'https://www.comfy.org/download'
}

const GROUPS = [
  { id: 'programs', title: 'Programs' },
  { id: 'chat', title: 'Chat and scripts' },
  { id: 'images', title: 'Images' }
] as const

function eta(p: DownloadProgress): string {
  if (!p.rate || !p.total || p.bytes >= p.total) return ''
  const s = (p.total - p.bytes) / p.rate
  if (s > 3600) return `about ${Math.round(s / 3600)} h left`
  if (s > 90) return `about ${Math.round(s / 60)} min left`
  return 'less than 2 min left'
}

function phaseText(p: DownloadProgress): string {
  switch (p.phase) {
    case 'waiting':
      return 'Waiting'
    case 'checking':
      return 'Finding the official file…'
    case 'downloading':
      return p.total ? `${formatBytes(p.bytes)} of ${formatBytes(p.total)}${eta(p) ? `, ${eta(p)}` : ''}` : 'Downloading…'
    case 'verifying':
    case 'installing':
      return p.message ?? 'Installing…'
    case 'done':
      return 'Done'
    case 'skipped':
    case 'failed':
      return p.message ?? 'Failed'
  }
}

/** Shared by the setup wizard and Settings. */
export function DownloadsPanel({ onFinished }: { onFinished?: () => void }) {
  const { notify, refreshServices } = useApp()
  const [statuses, setStatuses] = useState<ComponentStatus[] | null>(null)
  const [storeBuild, setStoreBuild] = useState(false)
  const [modelsDir, setModelsDir] = useState<string | null>(null)
  const [picked, setPicked] = useState<Set<ComponentId>>(new Set())
  const [space, setSpace] = useState<{ need: number; free: number | null } | null>(null)
  const [run, setRun] = useState<string | null>(null)
  const [progress, setProgress] = useState<Partial<Record<ComponentId, DownloadProgress>>>({})
  const [error, setError] = useState<string | null>(null)
  const runRef = useRef<string | null>(null)
  const initialised = useRef(false)

  const apply = useCallback((r: { statuses: ComponentStatus[]; storeBuild: boolean; modelsDir: string | null }) => {
    setStatuses(r.statuses)
    setStoreBuild(r.storeBuild)
    setModelsDir(r.modelsDir)
    if (!initialised.current) {
      initialised.current = true
      setPicked(new Set(r.statuses.filter((s) => s.state === 'missing' || s.state === 'unknown').map((s) => s.id).filter((id) => COMPONENTS.find((c) => c.id === id)!.recommended)))
    }
  }, [])
  const load = useCallback(() => call('setup:components').then(apply), [apply])
  useEffect(() => {
    let ok = true
    call('setup:components').then(
      (r) => ok && apply(r),
      (e: unknown) => ok && setError(errorText(e))
    )
    return () => {
      ok = false
    }
  }, [apply])

  const ids = useMemo(() => COMPONENTS.map((c) => c.id).filter((id) => picked.has(id)), [picked])
  useEffect(() => {
    let ok = true
    void call('setup:plan', { ids }).then((s) => ok && setSpace(s))
    return () => {
      ok = false
    }
  }, [ids])

  useEffect(() => {
    const offP = window.archai.on('setup:progress', (p) => {
      if (p.runId === runRef.current) setProgress((all) => ({ ...all, [p.id]: p }))
    })
    const offD = window.archai.on('setup:done', (d) => {
      if (d.runId !== runRef.current) return
      runRef.current = null
      setRun(null)
      // Finished items now show as Installed; keep messages for anything that failed.
      void load().then(() => setProgress((all) => Object.fromEntries(Object.entries(all).filter(([, p]) => p && p.phase !== 'done'))))
      void refreshServices()
      notify(d.ok ? 'Everything you chose is installed.' : "Some items didn't install. See the messages below.", !d.ok)
      if (d.ok) onFinished?.()
    })
    return () => {
      offP()
      offD()
    }
  }, [load, notify, refreshServices, onFinished])

  const start = async () => {
    setError(null)
    try {
      const r = await call('setup:download', { ids })
      runRef.current = r.runId
      setRun(r.runId)
      setProgress({})
    } catch (e) {
      setError(errorText(e))
    }
  }

  const chooseComfy = async () => {
    try {
      const r = await call('setup:pickComfyFolder')
      if (r.done) {
        notify('Image models will go into your ComfyUI.')
        await load()
      }
    } catch (e) {
      setError(errorText(e))
    }
  }

  if (!statuses) return <p className="field__hint">Checking what's already on this computer…</p>
  const st = (id: ComponentId) => statuses.find((s) => s.id === id)!
  const imagesPicked = ids.some((id) => COMPONENTS.find((c) => c.id === id)!.group === 'images')
  // Image models need a ComfyUI models folder: the one we install, or yours.
  const noModelsHome = imagesPicked && !modelsDir && !picked.has('comfyui')
  const ownComfy = st('comfyui').state === 'installed'
  const tooBig = space?.free !== null && space !== null && space.free !== null && space.free < space.need * 1.05

  return (
    <div className="downloads" data-testid="downloads">
      <p className="field__hint">
        Files come straight from their official sources (Ollama, GitHub and Hugging Face), and each one is checked against its published checksum. The internet
        is used only while these downloads run.{storeBuild ? " This Microsoft Store version can't install programs, so those link to their websites." : ''}
      </p>
      {GROUPS.map((g) => (
        <section key={g.id} className="dl-group">
          <h3 className="dl-group__title">{g.title}</h3>
          <ul className="dl-list">
            {COMPONENTS.filter((c) => c.group === g.id).map((c) => {
              const s = st(c.id)
              const p = progress[c.id]
              const installed = s.state === 'installed'
              const disabled = installed || s.state === 'unavailable' || !!run
              return (
                <li key={c.id} className={`dl-item dl-item--${p?.phase ?? s.state}`} data-testid={`dl-${c.id}`} data-state={p?.phase ?? s.state}>
                  <label className="dl-item__main">
                    <input
                      type="checkbox"
                      checked={!installed && picked.has(c.id)}
                      disabled={disabled}
                      onChange={(e) => {
                        const next = new Set(picked)
                        if (e.target.checked) next.add(c.id)
                        else next.delete(c.id)
                        setPicked(next)
                      }}
                    />
                    <span>
                      <span className="dl-item__name">{c.name}</span>
                      <span className="dl-item__what">{c.what}</span>
                      <span className="dl-item__meta">
                        {installed ? 'Installed' : `About ${formatBytes(c.approxBytes)}`} · <a href={c.licenceUrl} target="_blank" rel="noreferrer">{c.licence} licence</a>
                        {s.state === 'unavailable' && OFFICIAL[c.id] && (
                          <>
                            {' '}· <a href={OFFICIAL[c.id]} target="_blank" rel="noreferrer">Download from the official website</a>
                          </>
                        )}
                      </span>
                      {s.note && !installed && <span className="dl-item__note">{s.note}</span>}
                    </span>
                  </label>
                  {p && (
                    <div className="dl-item__progress">
                      <span className="dl-item__phase">{phaseText(p)}</span>
                      {(p.phase === 'downloading' || p.phase === 'installing') && p.total > 0 && (
                        <div className="bar">
                          <span style={{ width: `${Math.min(100, (p.bytes / p.total) * 100)}%` }} />
                        </div>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      ))}

      {noModelsHome && (
        <p className="field__warn">
          {ownComfy ? "ComfyUI is running, but ArchAI Studio doesn't know where its models folder is. " : "Image models go into ComfyUI's models folder. Tick ComfyUI above, or "}
          <button type="button" className="linkbtn" onClick={() => void chooseComfy()} data-testid="choose-comfy">
            {ownComfy ? 'Choose your ComfyUI folder' : 'choose your own ComfyUI folder'}
          </button>
          .
        </p>
      )}
      {modelsDir && <p className="field__hint">Image models go into {modelsDir}</p>}
      {space && ids.length > 0 && (
        <p className={tooBig ? 'field__warn' : 'field__hint'} data-testid="dl-space">
          Needs about {formatBytes(space.need)}
          {space.free !== null ? `. ${formatBytes(space.free)} free on this drive.` : '.'} gpt-oss:20b alone is about 14 GB, so the first setup can take an hour or more on
          a typical connection. Downloads resume if they stop.
        </p>
      )}
      {error && <p className="msg__error" role="alert" data-testid="dl-error">{error}</p>}
      <div className="row">
        {run ? (
          <button type="button" className="btn" onClick={() => void call('setup:cancel', { runId: run })} data-testid="dl-stop">Stop downloads</button>
        ) : (
          <button type="button" className="btn btn--primary" onClick={() => void start()} disabled={ids.length === 0 || noModelsHome || tooBig} data-testid="dl-start">
            Download and install{space && ids.length ? ` (${formatBytes(space.need)})` : ''}
          </button>
        )}
      </div>
    </div>
  )
}
