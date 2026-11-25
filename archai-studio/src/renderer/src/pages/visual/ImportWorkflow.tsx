import { useEffect, useRef, useState } from 'react'
import type { WorkflowImportPreview } from '@shared/ipc'
import { BINDING_KEYS, checkBindings, type Bindings, type BindingKey, type ImageMode, type WorkflowInfo } from '@shared/images'
import { call, errorText } from '../../lib/ipc'

const LABELS: Record<BindingKey, string> = {
  positive: 'Prompt',
  negative: 'Negative prompt',
  seed: 'Seed',
  steps: 'Steps',
  cfg: 'CFG',
  denoise: 'Denoise (variation)',
  guidance: 'Flux guidance',
  checkpoint: 'Checkpoint model',
  controlnet: 'ControlNet model',
  unet: 'Diffusion model (UNET loader)',
  clip1: 'Text encoder 1',
  clip2: 'Text encoder 2',
  vae: 'VAE',
  strength: 'ControlNet strength',
  image: 'Input image',
  width: 'Width',
  height: 'Height',
  prefix: 'File name prefix'
}

/** Imports a ComfyUI API-format workflow and lets you confirm which node is which. */
export function ImportWorkflow({ onClose, onSaved }: { onClose: () => void; onSaved: (w: WorkflowInfo) => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  const [preview, setPreview] = useState<WorkflowImportPreview | null>(null)
  const [name, setName] = useState('')
  const [mode, setMode] = useState<ImageMode>('text')
  const [bindings, setBindings] = useState<Bindings>({})
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)

  useEffect(() => {
    ref.current?.showModal()
    if (started.current) return
    started.current = true
    call('images:importWorkflow').then(
      (p) => {
        if (!p) return ref.current?.close()
        setPreview(p)
        setName(p.name)
        setMode(p.mode)
        setBindings(p.bindings)
      },
      (e: unknown) => setError(errorText(e))
    )
  }, [])

  const problems = preview
    ? checkBindings(
        Object.fromEntries(preview.nodes.map((n) => [n.id, { class_type: n.classType, inputs: Object.fromEntries(n.inputs.map((i) => [i, 0])) }])),
        bindings,
        mode
      )
    : []

  const save = async () => {
    if (!preview) return
    try {
      onSaved(await call('images:saveWorkflow', { token: preview.token, name, mode, bindings }))
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <dialog ref={ref} className="dialog importwf" onClose={onClose} aria-labelledby="iw-title" data-testid="import-dialog">
      <h2 className="dialog__title" id="iw-title">Import a ComfyUI workflow</h2>
      {error && <p className="msg__error" role="alert">{error}</p>}
      {!preview && !error && <p className="field__hint">Choose a workflow exported from ComfyUI with Workflow → Export (API).</p>}
      {preview && (
        <div className="importwf__body">
          <label className="field">
            <span className="field__label">Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </label>
          <div className="field">
            <span className="field__label">Use it for</span>
            <div className="segmented" role="group">
              {(['text', 'sketch', 'variation'] as ImageMode[]).map((m) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
                  {m === 'text' ? 'Text to image' : m === 'sketch' ? 'Sketch to render' : 'Variation'}
                </button>
              ))}
            </div>
          </div>
          <p className="field__hint">ArchAI found these nodes. Check that each one is right. Leave a setting blank to keep the workflow's own value.</p>
          <div className="importwf__grid">
            {BINDING_KEYS.map((k) => {
              const b = bindings[k]
              return (
                <label key={k} className="field">
                  <span className="field__hint">{LABELS[k]}</span>
                  <select
                    className="input"
                    value={b ? `${b.node}|${b.input}` : ''}
                    onChange={(e) => {
                      const v = e.target.value
                      const next = { ...bindings }
                      if (!v) delete next[k]
                      else {
                        const [node, input] = v.split('|') as [string, string]
                        next[k] = { node, input }
                      }
                      setBindings(next)
                    }}
                  >
                    <option value="">Not used</option>
                    {preview.nodes.flatMap((n) =>
                      n.inputs.map((i) => (
                        <option key={`${n.id}|${i}`} value={`${n.id}|${i}`}>
                          {n.id} {n.classType}: {i}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              )
            })}
          </div>
          {problems.length > 0 && <p className="field__warn">{problems[0]}</p>}
        </div>
      )}
      <div className="dialog__actions">
        <button type="button" className="btn" onClick={() => ref.current?.close()}>Cancel</button>
        {preview && (
          <button type="button" className="btn btn--primary" onClick={() => void save()} disabled={problems.length > 0 || !name.trim()} data-testid="import-save">
            Import workflow
          </button>
        )}
      </div>
    </dialog>
  )
}
