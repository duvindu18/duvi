import { useCallback, useEffect, useRef, useState } from 'react'
import { extractCode, SCRIPT_TARGETS, TARGETS, type SavedScript, type ScriptTarget } from '@shared/scripts'
import { Markdown } from '../../components/Markdown'
import { call, errorText } from '../../lib/ipc'
import { useApp } from '../../state/AppState'
import { ScriptEditor, type ScriptEditorHandle } from './ScriptEditor'

type Job = 'generate' | 'explain' | 'fix'

interface Live {
  streamId: string
  job: Job
  text: string
}

const JOB_LABEL: Record<Job, string> = { generate: 'Writing the script…', explain: 'Explaining…', fix: 'Fixing…' }

export function ScriptsPage() {
  const { activeProject, settings, notify } = useApp()
  const projectId = activeProject?.id ?? 0
  const [target, setTarget] = useState<ScriptTarget>('dynamo')
  const [task, setTask] = useState('')
  const [traceback, setTraceback] = useState('')
  const [showFix, setShowFix] = useState(false)
  const [threadId, setThreadId] = useState<number | null>(null)
  const [title, setTitle] = useState('')
  const [hasCode, setHasCode] = useState(false)
  const [notes, setNotes] = useState<string | null>(null)
  const [live, setLive] = useState<Live | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState<SavedScript[]>([])
  const editor = useRef<ScriptEditorHandle>(null)
  const stream = useRef<{ id: string; job: Job } | null>(null)
  const targetRef = useRef(target)
  useEffect(() => {
    targetRef.current = target
  }, [target])

  const t = TARGETS[target]
  const model = settings?.models.scripts ?? 'gpt-oss:20b'

  const loadSaved = useCallback(() => {
    void call('scripts:list', { projectId }).then(setSaved, () => setSaved([]))
  }, [projectId])
  useEffect(() => {
    loadSaved()
  }, [loadSaved])

  useEffect(() => {
    const offChunk = window.archai.on('chat:chunk', (c) => {
      if (stream.current?.id !== c.streamId) return
      setLive((l) => (l ? { ...l, text: l.text + (c.content ?? '') } : l))
    })
    const offDone = window.archai.on('chat:done', (d) => {
      const s = stream.current
      if (s?.id !== d.streamId) return
      stream.current = null
      setLive(null)
      if (s.job === 'explain') {
        setNotes(d.message.content)
        return
      }
      const { code, notes: rest } = extractCode(d.message.content, TARGETS[targetRef.current].fence)
      if (code) {
        editor.current?.setValue(code)
        setNotes(rest || null)
      } else {
        setNotes(d.message.content)
        setError('The model replied without a script. Try rewording the task, or ask again.')
      }
      if (d.message.meta?.stopped) setError('Stopped before the end. The script may be incomplete.')
    })
    const offErr = window.archai.on('chat:error', (e) => {
      if (stream.current?.id !== e.streamId) return
      stream.current = null
      setLive(null)
      setError(e.message)
    })
    return () => {
      offChunk()
      offDone()
      offErr()
    }
  }, [])

  const run = async (job: Job) => {
    if (live || !activeProject) return
    setError(null)
    const code = editor.current?.getValue() ?? ''
    try {
      const base = { projectId, target, model, threadId: job === 'generate' ? null : threadId }
      const r =
        job === 'generate'
          ? await call('scripts:generate', { ...base, task })
          : job === 'explain'
            ? await call('scripts:explain', { ...base, code })
            : await call('scripts:fix', { ...base, code, error: traceback })
      stream.current = { id: r.streamId, job }
      setThreadId(r.threadId)
      if (job === 'generate') setTitle(task.trim().slice(0, 120))
      setLive({ streamId: r.streamId, job, text: '' })
      setNotes(null)
      if (job === 'fix') setShowFix(false)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const pickTarget = (id: ScriptTarget) => {
    if (live || id === target) return
    setTarget(id)
    setThreadId(null)
    setNotes(null)
    setError(null)
  }

  const copy = async () => {
    await call('clipboard:writeText', { text: editor.current?.getValue() ?? '' })
    notify('Script copied')
  }

  const save = async () => {
    try {
      const r = await call('scripts:save', { projectId, target, title: title || `${t.name} script`, code: editor.current?.getValue() ?? '' })
      if (r.done) {
        notify(`Saved ${r.script.path?.split(/[\\/]/).pop() ?? 'script'}`)
        loadSaved()
      }
    } catch (e) {
      notify(errorText(e), true)
    }
  }

  const open = (s: SavedScript) => {
    if (live) return
    setTarget(s.target)
    setTitle(s.title)
    setThreadId(null)
    setNotes(null)
    setError(null)
    // Let the language switch apply first.
    window.setTimeout(() => editor.current?.setValue(s.code), 0)
  }

  return (
    <div className="scripts" data-testid="scripts">
      <header className="scripts__head">
        <h1 className="page-title">Script Studio</h1>
        <p className="banner" role="note" data-testid="review-banner">
          Review every script before you run it. ArchAI Studio never runs scripts in Revit, Rhino, AutoCAD or Blender itself. Try them on a copy of the model first.
        </p>
        <div className="targets" role="radiogroup" aria-label="Program">
          {SCRIPT_TARGETS.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={id === target}
              className="target"
              onClick={() => pickTarget(id)}
              disabled={!!live && id !== target}
              data-testid={`target-${id}`}
            >
              <span className="target__name">{TARGETS[id].name}</span>
              <span className="target__program">{TARGETS[id].program}</span>
            </button>
          ))}
        </div>
      </header>

      <div className="scripts__body">
        <div className="scripts__side">
          <label className="field">
            <span className="field__label">What should the script do?</span>
            <textarea
              className="composer__input"
              rows={6}
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder={t.example}
              data-testid="script-task"
            />
          </label>
          <div className="row">
            <button type="button" className="btn btn--primary" onClick={() => void run('generate')} disabled={!!live || !task.trim()} data-testid="script-generate">
              Generate {t.name}
            </button>
            {live && (
              <button type="button" className="btn" onClick={() => void call('chat:cancel', { streamId: live.streamId })} data-testid="script-stop">
                Stop
              </button>
            )}
          </div>

          {saved.length > 0 && (
            <div className="saved">
              <h2 className="saved__title">Saved in this project</h2>
              <ul>
                {saved.map((s) => (
                  <li key={s.id}>
                    <button type="button" onClick={() => open(s)} title={s.path ?? undefined}>
                      <span>{s.title}</span>
                      <span className="saved__meta">{TARGETS[s.target].name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="scripts__work">
          <div className="toolbar">
            <span className="toolbar__file">{title ? `${title.slice(0, 60)}${title.length > 60 ? '…' : ''}` : `New ${t.name} script`}</span>
            <button type="button" className="btn btn--quiet" onClick={() => void run('explain')} disabled={!!live || !hasCode} data-testid="script-explain">
              Explain this script
            </button>
            <button type="button" className="btn btn--quiet" onClick={() => setShowFix((v) => !v)} disabled={!!live || !hasCode} aria-expanded={showFix} data-testid="script-fix-open">
              Fix this error
            </button>
            <button type="button" className="btn btn--quiet" onClick={() => void copy()} disabled={!hasCode} data-testid="script-copy">
              Copy
            </button>
            <button type="button" className="btn" onClick={() => void save()} disabled={!hasCode || !!live} data-testid="script-save">
              Save as .{t.ext}
            </button>
          </div>
          {showFix && (
            <div className="fixpanel">
              <label className="field">
                <span className="field__label">Paste the error message or traceback</span>
                <textarea className="composer__input mono" rows={5} value={traceback} onChange={(e) => setTraceback(e.target.value)} data-testid="script-traceback" />
              </label>
              <div className="row">
                <button type="button" className="btn btn--primary" onClick={() => void run('fix')} disabled={!traceback.trim()} data-testid="script-fix">
                  Fix the script
                </button>
                <button type="button" className="btn btn--quiet" onClick={() => setShowFix(false)}>Cancel</button>
              </div>
            </div>
          )}
          <ScriptEditor ref={editor} language={t.language} theme={settings?.theme ?? 'dark'} onChange={(v) => setHasCode(v.trim().length > 0)} />
          <section className="notes" aria-live="polite" data-testid="script-notes">
            {error && <p className="msg__error" role="alert" data-testid="script-error">{error}</p>}
            {live ? (
              <>
                <p className="notes__status">{JOB_LABEL[live.job]}</p>
                {live.text && <Markdown text={live.text} />}
              </>
            ) : notes ? (
              <Markdown text={notes} />
            ) : (
              !error && <p className="notes__empty">Describe a task and click Generate, or paste your own script into the editor to explain or fix it.</p>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
