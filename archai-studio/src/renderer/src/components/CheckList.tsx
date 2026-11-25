import type { CheckResult } from '@shared/checks'
import { call } from '../lib/ipc'
import { useApp } from '../state/AppState'

const STATUS_WORD = { ok: 'Ready', warn: 'Check this', fail: 'Needs attention' } as const

export function CheckList({ results }: { results: CheckResult[] }) {
  const { notify } = useApp()
  const copy = async (text: string) => {
    await call('clipboard:writeText', { text })
    notify('Command copied. Paste it into PowerShell.')
  }
  return (
    <ul className="checks" data-testid="checks">
      {results.map((r) => (
        <li key={r.id} className={`check check--${r.status}`} data-testid={`check-${r.id}`} data-status={r.status}>
          <span className="check__mark" aria-hidden="true" />
          <div className="check__body">
            <div className="check__head">
              <span className="check__title">{r.title}</span>
              <span className="check__status">{STATUS_WORD[r.status]}</span>
            </div>
            <p className="check__detail">{r.detail}</p>
            {r.fix && (
              <div className="fix">
                <p>{r.fix.text}</p>
                {r.fix.command && (
                  <div className="fix__cmd">
                    <code>{r.fix.command}</code>
                    <button type="button" className="btn btn--quiet" onClick={() => void copy(r.fix!.command!)} data-testid={`copy-${r.id}`}>
                      Copy
                    </button>
                  </div>
                )}
                {r.fix.link && (
                  <a className="fix__link" href={r.fix.link.url} target="_blank" rel="noreferrer">
                    {r.fix.link.label}
                  </a>
                )}
              </div>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}
