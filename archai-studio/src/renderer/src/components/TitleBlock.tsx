import { SECTION_NAMES, useApp } from '../state/AppState'
import { Mark } from './icons'

/** dd.mm.yyyy, as on Sri Lankan drawing sheets. */
function sheetDate(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`
}

/**
 * The window's status strip, drawn like the title block of a drawing sheet:
 * project, current sheet, local AI services, GPU, date, revision.
 * Service status is filled in by the first-run checks (M2).
 */
export function TitleBlock() {
  const { activeProject, section, info } = useApp()
  return (
    <footer className="titleblock" aria-label="Status" data-testid="titleblock">
      <div className="tb-cell tb-studio">
        <Mark className="tb-studio__mark" />
        <span>
          ArchAI <span className="tb-studio__light">Studio</span>
        </span>
      </div>
      <div className="tb-cell">
        <span className="tb-label">Project</span>
        <span className="tb-value tb-value--wide" data-testid="tb-project">{activeProject?.name ?? 'None'}</span>
      </div>
      <div className="tb-cell">
        <span className="tb-label">Sheet</span>
        <span className="tb-value">{SECTION_NAMES[section]}</span>
      </div>
      <div className="tb-cell">
        <span className="tb-label">Ollama</span>
        <span className="tb-value"><span className="status-dot" />Not checked</span>
      </div>
      <div className="tb-cell">
        <span className="tb-label">ComfyUI</span>
        <span className="tb-value"><span className="status-dot" />Not checked</span>
      </div>
      <div className="tb-cell">
        <span className="tb-label">Date</span>
        <span className="tb-value">{sheetDate()}</span>
      </div>
      <div className="tb-cell">
        <span className="tb-label">Rev</span>
        <span className="tb-value" data-testid="tb-rev">{info?.version ?? ''}</span>
      </div>
    </footer>
  )
}
