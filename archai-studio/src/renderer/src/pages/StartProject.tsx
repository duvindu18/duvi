import { ProjectNameForm } from '../components/ProjectNameForm'

export function StartProject() {
  return (
    <div className="start" data-testid="start-project">
      <h1 className="start__title">Start a project</h1>
      <p className="start__text">
        Chats, scripts and renders are kept per project, so you can come back to a job later. Name it the way you name the job in your office.
      </p>
      <ProjectNameForm autoFocus />
    </div>
  )
}
