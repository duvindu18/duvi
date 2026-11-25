import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  composePrompt,
  MODEL_KEYS,
  MODEL_LABEL,
  MODEL_LIST,
  pickModel,
  SIZES,
  STYLE_PRESETS,
  type ComfyModels,
  type GalleryImage,
  type ImageMode,
  type ImageProgress,
  type ModelChoice,
  type ModelKey,
  type PickedInput,
  type SizeId,
  type WorkflowInfo
} from '@shared/images'
import { call, errorText } from '../../lib/ipc'
import { useApp } from '../../state/AppState'
import { ImageDetail } from './ImageDetail'
import { ImportWorkflow } from './ImportWorkflow'

/** Where each kind of model file goes in ComfyUI, for the "missing file" hint. */
const MODEL_FOLDER: Record<ModelKey, string> = {
  checkpoint: 'models/checkpoints',
  controlnet: 'models/controlnet',
  unet: 'models/diffusion_models',
  clip1: 'models/text_encoders',
  clip2: 'models/text_encoders',
  vae: 'models/vae'
}

const MODES: { id: ImageMode; label: string; hint: string }[] = [
  { id: 'text', label: 'From text', hint: 'Describe a building or space.' },
  { id: 'sketch', label: 'From sketch', hint: 'Start from a hand sketch, line drawing or massing screenshot.' },
  { id: 'variation', label: 'Variation', hint: 'Redraw an image, keeping its layout and colours.' }
]

type Input = (PickedInput & { kind: 'file' }) | { kind: 'gallery'; imageId: number; url: string; name: string }

function stageText(p: ImageProgress): string {
  switch (p.stage) {
    case 'queued':
      return 'Sending to ComfyUI…'
    case 'loading':
      return 'Loading models. The first image after a chat takes longer…'
    case 'sampling':
      return `Rendering, step ${p.value} of ${p.max}`
    case 'saving':
      return 'Saving to the gallery…'
  }
}

export function VisualPage() {
  const { activeProject, settings, updateSettings, notify } = useApp()
  const projectId = activeProject?.id ?? 0
  const [mode, setMode] = useState<ImageMode>('text')
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([])
  const [workflowId, setWorkflowId] = useState<Record<ImageMode, string>>({ text: 'sdxl-text', sketch: 'sdxl-sketch-controlnet', variation: 'sdxl-variation' })
  const [models, setModels] = useState<ComfyModels | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [description, setDescription] = useState('')
  const [preset, setPreset] = useState<string | null>('tropical-modern')
  const [custom, setCustom] = useState<{ positive: string; negative: string } | null>(null)
  const [size, setSize] = useState<SizeId>('landscape')
  const [seedText, setSeedText] = useState('')
  // Steps, guidance and denoise follow the chosen workflow unless you change them.
  const [stepsOverride, setStepsOverride] = useState<number | null>(null)
  const [guidanceOverride, setGuidanceOverride] = useState<number | null>(null)
  const [denoiseOverride, setDenoiseOverride] = useState<number | null>(null)
  const [strength, setStrength] = useState(0.75)
  const [input, setInput] = useState<Input | null>(null)
  const [helping, setHelping] = useState(false)
  const [job, setJob] = useState<{ id: string; progress: ImageProgress | null } | null>(null)
  const jobRef = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [gallery, setGallery] = useState<GalleryImage[]>([])
  const [latest, setLatest] = useState<GalleryImage | null>(null)
  const [selected, setSelected] = useState<GalleryImage | null>(null)
  const [importing, setImporting] = useState(false)

  const auto = useMemo(() => composePrompt(description, preset), [description, preset])
  const prompt = custom ?? auto

  const loadWorkflows = useCallback(() => void call('images:workflows').then(setWorkflows), [])
  const loadModels = useCallback(() => {
    call('images:models').then(
      (m) => {
        setModels(m)
        setModelsError(null)
      },
      (e: unknown) => setModelsError(errorText(e))
    )
  }, [])
  useEffect(() => {
    loadWorkflows()
    loadModels()
  }, [loadWorkflows, loadModels])
  useEffect(() => {
    let ok = true
    void call('gallery:list', { projectId }).then((g) => {
      if (!ok) return
      setGallery(g)
      setLatest((l) => l ?? g[0] ?? null)
    })
    return () => {
      ok = false
    }
  }, [projectId])

  useEffect(() => {
    const offP = window.archai.on('images:progress', (p) => {
      if (jobRef.current === p.jobId) setJob({ id: p.jobId, progress: p })
    })
    const offD = window.archai.on('images:done', (d) => {
      if (jobRef.current !== d.jobId) return
      jobRef.current = null
      setJob(null)
      setGallery((g) => [...d.images, ...g])
      setLatest(d.images[0] ?? null)
    })
    const offE = window.archai.on('images:error', (e) => {
      if (jobRef.current !== e.jobId) return
      jobRef.current = null
      setJob(null)
      if (e.message !== 'Stopped.') setError(e.message)
    })
    return () => {
      offP()
      offD()
      offE()
    }
  }, [])

  const modeWorkflows = workflows.filter((w) => w.mode === mode)
  const wf = modeWorkflows.find((w) => w.id === workflowId[mode]) ?? modeWorkflows[0]
  const needsInput = mode !== 'text'
  const isFlux = wf?.family === 'flux'
  const num = (v: unknown, d: number) => (typeof v === 'number' ? v : d)
  const steps = stepsOverride ?? num(wf?.defaults?.steps, 30)
  const guidance = guidanceOverride ?? num(wf?.defaults?.guidance, 3.5)
  const denoise = denoiseOverride ?? num(wf?.defaults?.denoise, 0.55)
  const byWorkflow = settings?.images.byWorkflow ?? {}
  const stored = (wf && byWorkflow[wf.id]) || {}
  const modelKeys = MODEL_KEYS.filter((k) => wf?.bindings[k])
  const chosen: ModelChoice = {}
  for (const k of modelKeys) {
    const v = pickModel(models?.[MODEL_LIST[k]] ?? [], stored[k], wf?.defaults?.[k], wf?.prefer?.[k])
    if (v) chosen[k] = v
  }
  // Files the workflow needs that ComfyUI doesn't list.
  const missing = models ? modelKeys.filter((k) => !(models[MODEL_LIST[k]] ?? []).includes(chosen[k] ?? '')) : []
  const setModel = (k: ModelKey, v: string) => {
    if (wf) void updateSettings({ images: { byWorkflow: { ...byWorkflow, [wf.id]: { ...stored, [k]: v } } } })
  }
  const pickWorkflow = (id: string) => {
    setWorkflowId({ ...workflowId, [mode]: id })
    setStepsOverride(null)
    setGuidanceOverride(null)
    setDenoiseOverride(null)
  }
  const seed = seedText.trim() === '' ? null : Number(seedText)
  const seedInvalid = seed !== null && (!Number.isInteger(seed) || seed < 0)

  const help = async () => {
    if (!description.trim()) return setError('Describe the image first, then the prompt helper can expand it.')
    setHelping(true)
    setError(null)
    try {
      setCustom(await call('images:promptHelp', { description, preset, mode, family: wf?.family }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setHelping(false)
    }
  }

  const pick = async () => {
    try {
      const r = await call('images:pickInput')
      if (r) setInput({ ...r, kind: 'file' })
    } catch (e) {
      setError(errorText(e))
    }
  }

  const generate = async () => {
    if (!wf || job || !activeProject) return
    setError(null)
    try {
      const r = await call('images:generate', {
        projectId,
        workflowId: wf.id,
        positive: prompt.positive,
        negative: prompt.negative,
        seed: seedInvalid ? null : seed,
        steps,
        models: chosen,
        ...(wf.bindings.guidance && { guidance }),
        ...(wf.bindings.strength && { strength }),
        ...(wf.bindings.denoise && mode === 'variation' && { denoise }),
        ...(mode === 'text' && { size }),
        ...(input && needsInput && { input: input.kind === 'file' ? { token: input.token } : { imageId: input.imageId } }),
        preset,
        description
      })
      jobRef.current = r.jobId
      setJob({ id: r.jobId, progress: null })
    } catch (e) {
      setError(errorText(e))
    }
  }

  const useAsInput = (img: GalleryImage, as: ImageMode) => {
    setInput({ kind: 'gallery', imageId: img.id, url: img.url, name: `Gallery image ${img.seed}` })
    setMode(as)
    if (img.description) setDescription(img.description)
    setSelected(null)
  }

  const p = job?.progress
  const pct = p?.stage === 'sampling' ? Math.round((p.value / Math.max(1, p.max)) * 100) : p?.stage === 'saving' ? 100 : 4

  return (
    <div className="visual" data-testid="visual">
      <aside className="visual__form">
        <h1 className="page-title">Visual Studio</h1>
        <div className="segmented visual__modes" role="group" aria-label="Mode">
          {MODES.map((m) => (
            <button key={m.id} type="button" aria-pressed={m.id === mode} onClick={() => !job && setMode(m.id)} data-testid={`mode-${m.id}`}>
              {m.label}
            </button>
          ))}
        </div>
        <p className="field__hint">{MODES.find((m) => m.id === mode)?.hint}</p>

        <label className="field">
          <span className="field__label">Workflow</span>
          <select className="input" value={wf?.id ?? ''} onChange={(e) => pickWorkflow(e.target.value)} disabled={!!job} data-testid="workflow-picker">
            {modeWorkflows.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
          {wf && <span className="field__hint">{wf.description}</span>}
        </label>
        {missing.length > 0 && (
          <p className="field__warn" data-testid="missing-models">
            ComfyUI doesn't list {missing.map((k) => MODEL_LABEL[k].toLowerCase()).join(', ')} files for this workflow. Put the file
            {missing.length > 1 ? 's' : ''} in ComfyUI's {Array.from(new Set(missing.map((k) => MODEL_FOLDER[k]))).join(' and ')} folder, restart ComfyUI, then
            reopen Visual Studio.
          </p>
        )}

        {modelsError && (
          <p className="chat__banner" role="alert" data-testid="comfy-down">
            {modelsError}{' '}
            <button type="button" className="btn btn--quiet" onClick={loadModels}>Check again</button>
          </p>
        )}

        {needsInput && (
          <div className="field">
            <span className="field__label">{mode === 'sketch' ? 'Sketch or screenshot' : 'Image to vary'}</span>
            {input ? (
              <div className="inputimg">
                <img src={input.url} alt="" />
                <div>
                  <p className="inputimg__name">{input.name}</p>
                  <div className="row">
                    <button type="button" className="btn btn--quiet" onClick={() => void pick()}>Change…</button>
                    <button type="button" className="btn btn--quiet" onClick={() => setInput(null)}>Remove</button>
                  </div>
                </div>
              </div>
            ) : (
              <button type="button" className="dropzone" onClick={() => void pick()} data-testid="pick-input">
                Choose an image… <span>PNG or JPEG. Pick one from the gallery with “Use as sketch” or “Vary”.</span>
              </button>
            )}
          </div>
        )}

        <label className="field">
          <span className="field__label">Describe the image</span>
          <textarea
            className="composer__input"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Two-storey courtyard house on a sloping site in Kandy, clay tile roof, verandah facing the garden, late afternoon"
            data-testid="image-description"
          />
        </label>

        <div className="field">
          <span className="field__label">Style</span>
          <div className="chips" role="group" aria-label="Style">
            {STYLE_PRESETS.map((s) => (
              <button key={s.id} type="button" className="chip" aria-pressed={preset === s.id} onClick={() => setPreset(preset === s.id ? null : s.id)} data-testid={`preset-${s.id}`}>
                {s.name}
              </button>
            ))}
          </div>
        </div>

        <div className="row">
          <button type="button" className="btn" onClick={() => void help()} disabled={helping || !!job} data-testid="prompt-helper">
            {helping ? 'Writing the prompt…' : 'Improve with prompt helper'}
          </button>
        </div>

        <details className="promptbox" open={custom !== null}>
          <summary>Prompt sent to ComfyUI{custom ? ' (edited)' : ''}</summary>
          <label className="field">
            <span className="field__hint">Prompt</span>
            <textarea className="composer__input" rows={5} value={prompt.positive} onChange={(e) => setCustom({ ...prompt, positive: e.target.value })} data-testid="prompt-positive" />
          </label>
          <label className="field">
            <span className="field__hint">Negative prompt (things to avoid)</span>
            <textarea className="composer__input" rows={3} value={prompt.negative} onChange={(e) => setCustom({ ...prompt, negative: e.target.value })} data-testid="prompt-negative" />
            {isFlux && <span className="field__hint">Flux ignores the negative prompt. Describe what you want instead.</span>}
          </label>
          {custom && (
            <button type="button" className="btn btn--quiet" onClick={() => setCustom(null)}>
              Go back to the automatic prompt
            </button>
          )}
        </details>

        {mode === 'text' && (
          <div className="field">
            <span className="field__label">Shape</span>
            <div className="segmented" role="group" aria-label="Shape">
              {(Object.keys(SIZES) as SizeId[]).map((id) => (
                <button key={id} type="button" aria-pressed={size === id} onClick={() => setSize(id)}>
                  {SIZES[id].label}
                </button>
              ))}
            </div>
          </div>
        )}
        {mode === 'sketch' && wf?.bindings.strength && (
          <label className="field">
            <span className="field__label">How closely to follow the sketch: {strength.toFixed(2)}</span>
            <input type="range" min={0.3} max={1.2} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} />
          </label>
        )}
        {mode === 'variation' && (
          <label className="field">
            <span className="field__label">How much to change: {denoise.toFixed(2)}</span>
            <input type="range" min={0.2} max={0.9} step={0.05} value={denoise} onChange={(e) => setDenoiseOverride(Number(e.target.value))} />
          </label>
        )}

        <details className="advanced">
          <summary>Advanced</summary>
          <button type="button" className="btn btn--quiet" onClick={() => setImporting(true)} data-testid="import-workflow">Import a ComfyUI workflow…</button>
          {modelKeys.map((k) => {
            const list = models?.[MODEL_LIST[k]] ?? []
            const value = chosen[k] ?? ''
            return (
              <label className="field" key={k}>
                <span className="field__hint">{MODEL_LABEL[k]}</span>
                <select className="input" value={value} onChange={(e) => setModel(k, e.target.value)} data-testid={`model-${k}`}>
                  {(list.length ? list : [value || 'No files found']).map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </label>
            )
          })}
          {wf?.bindings.guidance && (
            <label className="field">
              <span className="field__hint">Flux guidance: {guidance.toFixed(1)} (about 3.5 for text and variations, 30 for Canny)</span>
              <input type="range" min={1} max={40} step={0.5} value={guidance} onChange={(e) => setGuidanceOverride(Number(e.target.value))} data-testid="guidance" />
            </label>
          )}
          <div className="row">
            <label className="field" style={{ flex: 1 }}>
              <span className="field__hint">Steps</span>
              <input className="input" type="number" min={1} max={150} value={steps} onChange={(e) => setStepsOverride(Math.max(1, Math.min(150, Number(e.target.value) || 30)))} data-testid="steps" />
            </label>
            <label className="field" style={{ flex: 2 }}>
              <span className="field__hint">Seed (blank for random)</span>
              <input className="input" inputMode="numeric" value={seedText} aria-invalid={seedInvalid || undefined} onChange={(e) => setSeedText(e.target.value)} data-testid="seed" />
            </label>
          </div>
        </details>

        <div className="visual__go">
          {job ? (
            <button type="button" className="btn" onClick={() => void call('images:cancel', { jobId: job.id })} data-testid="image-stop">Stop</button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void generate()}
              disabled={!prompt.positive.trim() || !description.trim() || (needsInput && !input) || !wf}
              data-testid="image-generate"
            >
              Generate image
            </button>
          )}
        </div>
        {error && <p className="msg__error" role="alert" data-testid="image-error">{error}</p>}
      </aside>

      <section className="visual__stage">
        <div className="stage" data-testid="stage">
          {job ? (
            <div className="stage__progress" data-testid="image-progress">
              <p>{p ? stageText(p) : 'Starting…'}</p>
              <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${pct}%` }} />
              </div>
            </div>
          ) : latest ? (
            <button type="button" className="stage__img" onClick={() => setSelected(latest)} data-testid="latest">
              <img src={latest.url} alt={latest.description || latest.positive} />
            </button>
          ) : (
            <div className="stage__empty">
              <p>Renders for {activeProject?.name} appear here.</p>
              <p className="field__hint">Each image is saved as a PNG with its prompt, seed and model inside, so you can recreate it later.</p>
            </div>
          )}
        </div>
        {gallery.length > 0 && (
          <div className="gallery">
            <h2 className="saved__title">Gallery, {gallery.length} {gallery.length === 1 ? 'image' : 'images'}</h2>
            <ul className="gallery__grid" data-testid="gallery">
              {gallery.map((g) => (
                <li key={g.id}>
                  <button type="button" onClick={() => setSelected(g)} title={g.description || g.positive}>
                    <img src={g.url} alt="" loading="lazy" />
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {selected && (
        <ImageDetail
          image={selected}
          onClose={() => setSelected(null)}
          onUse={useAsInput}
          onReuse={(img) => {
            setCustom({ positive: img.positive, negative: img.negative })
            setDescription(img.description)
            setSeedText(String(img.seed))
            setSelected(null)
            notify('Prompt and seed loaded. Generate to recreate it.')
          }}
          onTrashed={(id) => {
            setGallery((g) => g.filter((x) => x.id !== id))
            setLatest((l) => (l?.id === id ? null : l))
            setSelected(null)
            notify('Moved to the Recycle Bin')
          }}
        />
      )}
      {importing && (
        <ImportWorkflow
          onClose={() => setImporting(false)}
          onSaved={(w) => {
            loadWorkflows()
            setMode(w.mode)
            setWorkflowId((ids) => ({ ...ids, [w.mode]: w.id }))
            setImporting(false)
            notify(`Imported ${w.name}`)
          }}
        />
      )}
    </div>
  )
}
