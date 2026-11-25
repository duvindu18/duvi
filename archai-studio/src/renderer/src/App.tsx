import { Rail } from './components/Rail'
import { TitleBlock } from './components/TitleBlock'
import { Later } from './pages/Later'
import { SettingsPage } from './pages/Settings'
import { StartProject } from './pages/StartProject'
import { AppStateProvider, useApp } from './state/AppState'

function Main() {
  const { section, activeProject, settings } = useApp()
  if (!settings) return <main className="main" />
  let page
  if (section === 'settings') page = <SettingsPage />
  else if (!activeProject) page = <StartProject />
  else page = <Later section={section} />
  return (
    <main className="main" data-testid="main">
      {page}
    </main>
  )
}

function Toast() {
  const { toast } = useApp()
  if (!toast) return null
  return (
    <div className={`toast${toast.error ? ' toast--error' : ''}`} role={toast.error ? 'alert' : 'status'} data-testid="toast">
      {toast.text}
    </div>
  )
}

export function App() {
  return (
    <AppStateProvider>
      <div className="shell">
        <Rail />
        <Main />
        <TitleBlock />
      </div>
      <Toast />
    </AppStateProvider>
  )
}
