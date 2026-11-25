import { useEffect, useState } from 'react'
import type { AppInfo } from '@shared/ipc'

/** M0 placeholder screen. The real shell and design system arrive in M1. */
export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void window.archai.invoke('app:info').then((r) => (r.ok ? setInfo(r.data) : setError(r.error.message)))
  }, [])

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', color: '#e8e6e1', background: '#141414', minHeight: '100vh', padding: 48 }}>
      <h1 data-testid="app-title" style={{ fontWeight: 500, letterSpacing: '-0.01em' }}>ArchAI Studio</h1>
      {info && (
        <p data-testid="app-version" style={{ opacity: 0.6 }}>
          v{info.version} · {info.buildType} · Electron {info.electron}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  )
}
