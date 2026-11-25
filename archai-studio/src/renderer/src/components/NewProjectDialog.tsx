import { useEffect, useRef } from 'react'
import { ProjectNameForm } from './ProjectNameForm'

export function NewProjectDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="np-title">
      <h2 className="dialog__title" id="np-title">New project</h2>
      <ProjectNameForm onDone={() => ref.current?.close()} autoFocus>
        <button type="button" className="btn" onClick={() => ref.current?.close()}>
          Cancel
        </button>
      </ProjectNameForm>
    </dialog>
  )
}
