import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { ServicePing } from '@shared/checks'
import type { AppInfo } from '@shared/ipc'
import type { Project } from '@shared/projects'
import type { Settings, SettingsPatch } from '@shared/settings'
import { call, errorText } from '../lib/ipc'

export type Section = 'chat' | 'scripts' | 'visual' | 'skills' | 'documents' | 'settings'

export const SECTION_NAMES: Record<Section, string> = {
  chat: 'Chat',
  scripts: 'Script Studio',
  visual: 'Visual Studio',
  skills: 'Skills',
  documents: 'Documents',
  settings: 'Settings'
}

interface Toast {
  text: string
  error?: boolean
}

interface AppState {
  info: AppInfo | null
  settings: Settings | null
  projects: Project[]
  activeProject: Project | null
  section: Section
  toast: Toast | null
  services: ServicePing | null
  /** True until the first-run setup has been completed. */
  wizard: boolean
  finishSetup(): Promise<void>
  refreshServices(): Promise<void>
  setSection(s: Section): void
  updateSettings(p: SettingsPatch): Promise<Settings | null>
  replaceSettings(s: Settings): void
  refreshProjects(): Promise<void>
  createProject(name: string): Promise<Project>
  selectProject(id: number): Promise<void>
  notify(text: string, error?: boolean): void
}

const Ctx = createContext<AppState | null>(null)

export function useApp(): AppState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp outside provider')
  return v
}

function resolveTheme(theme: Settings['theme']): 'dark' | 'light' | 'phthalo' {
  if (theme !== 'system') return theme
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [section, setSection] = useState<Section>('chat')
  const [toast, setToast] = useState<Toast | null>(null)
  const [services, setServices] = useState<ServicePing | null>(null)

  const notify = useCallback((text: string, error = false) => {
    setToast({ text, error })
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), error ? 6000 : 2400)
  }, [])

  const refreshProjects = useCallback(async () => {
    setProjects(await call('projects:list'))
  }, [])

  useEffect(() => {
    void (async () => {
      try {
        const [i, s] = await Promise.all([call('app:info'), call('settings:get')])
        setInfo(i)
        setSettings(s)
        // The database is only opened once setup has confirmed the data folder.
        if (s.firstRunComplete) setProjects(await call('projects:list'))
      } catch (e) {
        notify(errorText(e), true)
      }
    })()
  }, [notify])

  const refreshServices = useCallback(async () => {
    try {
      setServices(await call('services:ping'))
    } catch {
      setServices(null)
    }
  }, [])

  // The title block shows whether Ollama and ComfyUI answer (local addresses only).
  const ready = settings?.firstRunComplete === true
  useEffect(() => {
    if (!ready) return
    let live = true
    const tick = () => void call('services:ping').then((p) => live && setServices(p), () => live && setServices(null))
    tick()
    const t = window.setInterval(tick, 20_000)
    return () => {
      live = false
      window.clearInterval(t)
    }
  }, [ready, settings?.endpoints.ollama, settings?.endpoints.comfy])

  // Theme follows Settings; "system" tracks Windows' light/dark choice live.
  useEffect(() => {
    if (!settings) return
    const apply = () => (document.documentElement.dataset.theme = resolveTheme(settings.theme))
    apply()
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [settings])

  const updateSettings = useCallback(
    async (p: SettingsPatch) => {
      try {
        const s = await call('settings:set', p)
        setSettings(s)
        return s
      } catch (e) {
        notify(errorText(e), true)
        return null
      }
    },
    [notify]
  )

  const createProject = useCallback(async (name: string) => {
    const p = await call('projects:create', { name })
    const [s, list] = await Promise.all([call('settings:get'), call('projects:list')])
    setSettings(s)
    setProjects(list)
    return p
  }, [])

  const selectProject = useCallback(
    async (id: number) => {
      await updateSettings({ activeProjectId: id })
    },
    [updateSettings]
  )

  const finishSetup = useCallback(async () => {
    const s = await updateSettings({ firstRunComplete: true })
    if (s) setProjects(await call('projects:list'))
  }, [updateSettings])

  const activeProject = useMemo(() => {
    if (!settings) return null
    return projects.find((p) => p.id === settings.activeProjectId) ?? null
  }, [projects, settings])

  const value: AppState = {
    info,
    settings,
    projects,
    activeProject,
    section,
    toast,
    services,
    wizard: settings !== null && !settings.firstRunComplete,
    finishSetup,
    refreshServices,
    setSection,
    updateSettings,
    replaceSettings: setSettings,
    refreshProjects,
    createProject,
    selectProject,
    notify
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
