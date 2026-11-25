import { useCallback, useEffect, useState } from 'react'
import { GB, type CheckResult } from '@shared/checks'
import { CheckList } from '../components/CheckList'
import { DownloadsPanel } from '../components/DownloadsPanel'
import { call, errorText } from '../lib/ipc'
import { useApp } from '../state/AppState'

const COUNT = ['No', 'One', 'Two', 'Three', 'Four', 'Five']

const STEPS = ['Welcome', 'Where to keep your work', 'Download what you need', 'Check your setup', 'Ready'] as const

/** Runs the checks and keeps the results; shared by the wizard and Settings. */
export function useChecks(auto: boolean) {
  const [results, setResults] = useState<CheckResult[] | null>(null)
  const [running, setRunning] = useState(false)
  const { refreshServices, notify } = useApp()
  const run = useCallback(async () => {
    setRunning(true)
    try {
      setResults(await call('checks:run'))
      void refreshServices()
    } catch (e) {
      notify(errorText(e), true)
    } finally {
      setRunning(false)
    }
  }, [refreshServices, notify])
  useEffect(() => {
    if (!auto) return
    let live = true
    void call('checks:run').then((r) => {
      if (!live) return
      setResults(r)
      void refreshServices()
    })
    return () => {
      live = false
    }
  }, [auto, refreshServices])
  return { results, running, run }
}

export function SetupWizard() {
  const [step, setStep] = useState(0)
  return (
    <div className="wizard" data-testid="wizard">
      <nav className="wizard__steps" aria-label="Setup steps">
        <p className="wizard__name">First-time setup</p>
        <ol>
          {STEPS.map((label, i) => (
            <li key={label} aria-current={i === step ? 'step' : undefined} className={i < step ? 'done' : undefined}>
              <span className="wizard__num">{i + 1}</span>
              {label}
            </li>
          ))}
        </ol>
      </nav>
      <div className="wizard__body">
        {step === 0 && <Welcome next={() => setStep(1)} />}
        {step === 1 && <Folders back={() => setStep(0)} next={() => setStep(2)} />}
        {step === 2 && <Downloads back={() => setStep(1)} next={() => setStep(3)} />}
        {step === 3 && <Checks back={() => setStep(2)} next={() => setStep(4)} />}
        {step === 4 && <Ready back={() => setStep(3)} />}
      </div>
    </div>
  )
}

function Nav({ back, next, nextLabel = 'Continue', nextDisabled }: { back?: () => void; next: () => void; nextLabel?: string; nextDisabled?: boolean }) {
  return (
    <div className="wizard__nav">
      {back && <button type="button" className="btn btn--quiet" onClick={back}>Back</button>}
      <button type="button" className="btn btn--primary" onClick={next} disabled={nextDisabled} data-testid="wizard-next">{nextLabel}</button>
    </div>
  )
}

function Welcome({ next }: { next: () => void }) {
  return (
    <section>
      <h1 className="page-title">Welcome to ArchAI Studio</h1>
      <div className="wizard__text">
        <p>
          ArchAI Studio helps with day-to-day practice: questions about a project, scripts for Revit, Rhino and AutoCAD, and renders from your
          sketches. It works entirely on this computer. Nothing you type or draw is sent to the internet.
        </p>
        <p>It uses two programs you install yourself:</p>
        <ul>
          <li><strong>Ollama</strong> runs the language model (gpt-oss:20b) for chat and scripts.</li>
          <li><strong>ComfyUI</strong> runs the image models for renders.</li>
        </ul>
        <p>
          If they aren't on this computer yet, ArchAI Studio can download and install them for you, together with the AI models. You choose
          what to download, and the internet is used only while those downloads run.
        </p>
      </div>
      <Nav next={next} />
    </section>
  )
}

function Checks({ back, next }: { back: () => void; next: () => void }) {
  const { results, running, run } = useChecks(true)
  const failed = results?.filter((r) => r.status === 'fail').length ?? 0
  return (
    <section>
      <h1 className="page-title">Check your setup</h1>
      <p className="page-lede">
        {results === null
          ? 'Checking Ollama, ComfyUI, your graphics card and free space…'
          : failed === 0
            ? 'Everything you need is ready.'
            : `${COUNT[failed] ?? failed} ${failed === 1 ? 'thing needs' : 'things need'} attention. Follow the steps below, then check again. You can also continue and fix it later from Settings.`}
      </p>
      {results && <CheckList results={results} />}
      <div className="wizard__nav">
        <button type="button" className="btn btn--quiet" onClick={back}>Back</button>
        <button type="button" className="btn" onClick={() => void run()} disabled={running || results === null} data-testid="check-again">
          {running ? 'Checking…' : 'Check again'}
        </button>
        <button type="button" className="btn btn--primary" onClick={next} disabled={results === null} data-testid="wizard-next">
          {failed ? 'Continue anyway' : 'Continue'}
        </button>
      </div>
    </section>
  )
}

function FreeSpace({ path }: { path: string }) {
  const [bytes, setBytes] = useState<number | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void call('disk:free', { path }).then((r) => live && setBytes(r.bytes))
    return () => {
      live = false
    }
  }, [path])
  if (bytes === undefined) return null
  return <span className="field__hint">{bytes === null ? 'Free space unknown.' : `${(bytes / GB).toFixed(0)} GB free on this drive.`}</span>
}

function Downloads({ back, next }: { back: () => void; next: () => void }) {
  return (
    <section>
      <h1 className="page-title">Download what you need</h1>
      <p className="page-lede">Tick what to download. Anything already on this computer is marked Installed. You can skip this and add things later from Settings.</p>
      <div className="wizard__fields">
        <DownloadsPanel />
      </div>
      <Nav back={back} next={next} nextLabel="Continue" />
    </section>
  )
}

function Folders({ back, next }: { back: () => void; next: () => void }) {
  const { settings, updateSettings } = useApp()
  if (!settings) return null
  const { data, gallery } = settings.folders
  const pick = async (which: 'data' | 'gallery') => {
    const r = await call('dialog:pickFolder', {
      title: which === 'data' ? 'Choose where to keep your work' : 'Choose where to keep image galleries',
      defaultPath: which === 'data' ? data : (gallery ?? undefined)
    })
    if (r.done) await updateSettings({ folders: { [which]: r.path } })
  }
  return (
    <section>
      <h1 className="page-title">Where to keep your work</h1>
      <p className="page-lede">Projects, chats and scripts are saved here. Your fast NVMe drive (C:) is the best place.</p>
      <div className="wizard__fields">
        <div className="field">
          <span className="field__label">Data folder</span>
          <div className="row">
            <span className="path" title={data} data-testid="wizard-data-folder">{data}</span>
            <button className="btn" type="button" onClick={() => void pick('data')} data-testid="pick-data">Choose…</button>
          </div>
          <FreeSpace path={data} />
        </div>
        <label className="switch">
          <input
            type="checkbox"
            checked={gallery !== null}
            onChange={(e) => (e.target.checked ? void pick('gallery') : void updateSettings({ folders: { gallery: null } }))}
            data-testid="gallery-toggle"
          />
          <span>
            Keep image galleries on another drive
            <span className="field__hint" style={{ display: 'block' }}>Renders take a lot of space. Your 2 TB D: drive is a good home for them.</span>
          </span>
        </label>
        {gallery !== null && (
          <div className="field">
            <span className="field__label">Image gallery folder</span>
            <div className="row">
              <span className="path" title={gallery} data-testid="wizard-gallery-folder">{gallery}</span>
              <button className="btn" type="button" onClick={() => void pick('gallery')}>Choose…</button>
            </div>
            <FreeSpace path={gallery} />
          </div>
        )}
      </div>
      <Nav back={back} next={next} />
    </section>
  )
}

function Ready({ back }: { back: () => void }) {
  const { finishSetup } = useApp()
  return (
    <section>
      <h1 className="page-title">You're set up</h1>
      <div className="wizard__text">
        <p>Next, name your first project. You can rerun these checks at any time from Settings.</p>
        <p>The strip along the bottom of the window shows whether Ollama and ComfyUI are running.</p>
      </div>
      <Nav back={back} next={() => void finishSetup()} nextLabel="Start using ArchAI Studio" />
    </section>
  )
}

/** Settings group: rerun the checks after setup. */
export function SetupChecksPanel() {
  const { results, running, run } = useChecks(false)
  return (
    <>
      {results && <CheckList results={results} />}
      <div className="row">
        <button type="button" className="btn" onClick={() => void run()} disabled={running} data-testid="settings-run-checks">
          {running ? 'Checking…' : results ? 'Check again' : 'Run setup checks'}
        </button>
      </div>
    </>
  )
}
