import { Rail } from './components/Rail'
import { TitleBlock } from './components/TitleBlock'
import { ChatPage } from './pages/chat/Chat'
import { Later } from './pages/Later'
import { SetupWizard } from './pages/Setup'
import { SettingsPage } from './pages/Settings'
import { StartProject } from './pages/StartProject'
import { AppStateProvider, useApp } from './state/AppState'

function Main() {
  const { section, activeProject, settings } = useApp()
  if (!settings) return <main className="main" />
  let page
  if (section === 'settings') page = <SettingsPage />
  else if (!activeProject) page = <StartProject />
  else if (section === 'chat') page = <ChatPage key={activeProject.id} />
  else page = <Later section={section} />
  const flush = section === 'chat' && activeProject
  return (
    <main className={`main${flush ? ' main--flush' : ''}`} data-testid="main">
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

function Shell() {
  const { settings, wizard } = useApp()
  if (!settings) return <div className="shell" />
  return (
    <div className={`shell${wizard ? ' shell--wizard' : ''}`}>
      {wizard ? <SetupWizard /> : <><Rail /><Main /></>}
      <TitleBlock />
    </div>
  )
}

export function App() {
  return (
    <AppStateProvider>
      <Shell />
      <Toast />
    </AppStateProvider>
  )
}
