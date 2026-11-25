import { useState, type FormEvent } from 'react'
import { errorText } from '../lib/ipc'
import { useApp } from '../state/AppState'

/** Shared by the first-project screen and the New project dialog. */
export function ProjectNameForm({ onDone, autoFocus, children }: { onDone?: () => void; autoFocus?: boolean; children?: React.ReactNode }) {
  const { createProject, notify } = useApp()
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return setError('Give the project a name.')
    setBusy(true)
    try {
      const p = await createProject(name)
      notify(`Created ${p.name}`)
      setName('')
      setError(null)
      onDone?.()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="start__form" noValidate>
      <label className="field">
        <span className="field__label">Project name</span>
        <input
          className="input"
          value={name}
          maxLength={120}
          placeholder="Kandy Residence"
          aria-invalid={error ? true : undefined}
          autoFocus={autoFocus}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          data-testid="project-name"
        />
        {error && <span className="field__error" role="alert">{error}</span>}
      </label>
      <div style={{ paddingTop: 25, display: 'flex', gap: 8 }}>
        {children}
        <button className="btn btn--primary" type="submit" disabled={busy} data-testid="project-create">
          Create project
        </button>
      </div>
    </form>
  )
}
