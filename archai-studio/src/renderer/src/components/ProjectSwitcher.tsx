import { useEffect, useRef, useState } from 'react'
import { useApp } from '../state/AppState'
import { IconChevron } from './icons'
import { NewProjectDialog } from './NewProjectDialog'

export function ProjectSwitcher() {
  const { projects, activeProject, selectProject } = useApp()
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <div className="switcher" ref={ref}>
      <button
        type="button"
        className="switcher__button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        data-testid="project-switcher"
      >
        <span>
          <span className="switcher__label">Project</span>
          <span className="switcher__name">{activeProject?.name ?? 'No project yet'}</span>
        </span>
        <IconChevron />
      </button>
      {open && (
        <div className="switcher__panel">
          <div role="listbox" aria-label="Projects">
          {projects.map((p) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={p.id === activeProject?.id}
              className="switcher__item"
              onClick={() => {
                setOpen(false)
                void selectProject(p.id)
              }}
            >
              {p.name}
            </button>
          ))}
          </div>
          <div className={projects.length ? 'switcher__new' : undefined}>
            <button
              type="button"
              className="switcher__item"
              onClick={() => {
                setOpen(false)
                setCreating(true)
              }}
            >
              New project…
            </button>
          </div>
        </div>
      )}
      {creating && <NewProjectDialog onClose={() => setCreating(false)} />}
    </div>
  )
}
