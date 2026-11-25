import { SECTION_NAMES, useApp, type Section } from '../state/AppState'
import { IconChat, IconDocs, IconScript, IconSettings, IconSkills, IconVisual } from './icons'
import { ProjectSwitcher } from './ProjectSwitcher'

const MAIN: { id: Section; icon: () => React.JSX.Element; later?: string }[] = [
  { id: 'chat', icon: IconChat },
  { id: 'scripts', icon: IconScript },
  { id: 'visual', icon: IconVisual },
  { id: 'skills', icon: IconSkills },
  { id: 'documents', icon: IconDocs, later: 'Phase 2' }
]

export function Rail() {
  const { section, setSection } = useApp()
  const item = (id: Section, Icon: () => React.JSX.Element, later?: string) => (
    <button
      key={id}
      type="button"
      className="nav__item"
      aria-current={section === id ? 'page' : undefined}
      onClick={() => setSection(id)}
      data-testid={`nav-${id}`}
    >
      <Icon />
      {SECTION_NAMES[id]}
      {later && <span className="nav__later">{later}</span>}
    </button>
  )
  return (
    <nav className="rail" aria-label="Sections">
      <ProjectSwitcher />
      <div className="nav">{MAIN.map((m) => item(m.id, m.icon, m.later))}</div>
      <div className="nav nav--bottom">{item('settings', IconSettings)}</div>
    </nav>
  )
}
