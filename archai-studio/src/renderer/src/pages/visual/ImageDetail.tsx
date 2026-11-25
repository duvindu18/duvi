import { useEffect, useRef, useState } from 'react'
import type { GalleryImage, ImageMode } from '@shared/images'
import { call, errorText } from '../../lib/ipc'
import { useApp } from '../../state/AppState'

export function ImageDetail(props: {
  image: GalleryImage
  onClose: () => void
  onUse: (img: GalleryImage, as: ImageMode) => void
  onReuse: (img: GalleryImage) => void
  onTrashed: (id: number) => void
}) {
  const { image: img } = props
  const { notify } = useApp()
  const ref = useRef<HTMLDialogElement>(null)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  const created = new Date(img.createdAt)
  return (
    <dialog ref={ref} className="dialog detail" onClose={props.onClose} aria-label="Image details" data-testid="image-detail">
      <img className="detail__img" src={img.url} alt={img.description || img.positive} />
      <div className="detail__side">
        <dl className="detail__meta">
          <dt>Prompt</dt>
          <dd>{img.positive}</dd>
          <dt>Negative prompt</dt>
          <dd>{img.negative || 'None'}</dd>
          <dt>Seed</dt>
          <dd data-testid="detail-seed">{img.seed}</dd>
          <dt>Model</dt>
          <dd>{img.model ?? 'Set in the workflow'}</dd>
          <dt>Size</dt>
          <dd>{img.width && img.height ? `${img.width} × ${img.height} px` : 'Unknown'}</dd>
          <dt>Made</dt>
          <dd>{created.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</dd>
        </dl>
        <div className="detail__actions">
          <button type="button" className="btn" onClick={() => props.onUse(img, 'variation')} data-testid="detail-vary">Vary this image</button>
          <button type="button" className="btn" onClick={() => props.onUse(img, 'sketch')}>Use as sketch</button>
          <button type="button" className="btn" onClick={() => props.onReuse(img)}>Reuse prompt and seed</button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => void call('clipboard:writeText', { text: img.positive }).then(() => notify('Prompt copied'))}
          >
            Copy prompt
          </button>
          <button type="button" className="btn btn--quiet" onClick={() => void call('gallery:reveal', { id: img.id })}>Show in folder</button>
          {confirm ? (
            <span className="row">
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => void call('gallery:trash', { id: img.id }).then(() => props.onTrashed(img.id), (e: unknown) => notify(errorText(e), true))}
                data-testid="detail-trash-confirm"
              >
                Move to Recycle Bin
              </button>
              <button type="button" className="btn btn--quiet" onClick={() => setConfirm(false)}>Keep</button>
            </span>
          ) : (
            <button type="button" className="btn btn--quiet btn--danger" onClick={() => setConfirm(true)} data-testid="detail-trash">Remove…</button>
          )}
        </div>
        <button type="button" className="btn btn--quiet detail__close" onClick={() => ref.current?.close()}>Close</button>
      </div>
    </dialog>
  )
}
