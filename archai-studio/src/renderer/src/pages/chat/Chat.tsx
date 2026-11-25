import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ChatMessage, ModelInfo, Thread } from '@shared/chat'
import { CONTEXT_VRAM_WARNING } from '@shared/settings'
import { Markdown } from '../../components/Markdown'
import { call, errorText } from '../../lib/ipc'
import { useApp } from '../../state/AppState'

interface Live {
  streamId: string
  threadId: number
  content: string
  thinking: string
}

const EXAMPLES = [
  'Draft a short design statement for a courtyard house on a sloping site in Kandy.',
  'Compare clay tile and metal sheet roofing for a coastal house in Galle.',
  'What should I prepare before submitting a building application to the UDA?'
]

export function ChatPage() {
  const { activeProject, settings, setSection } = useApp()
  const projectId = activeProject?.id ?? 0
  const [threads, setThreads] = useState<Thread[]>([])
  const [threadId, setThreadId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [models, setModels] = useState<ModelInfo[] | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)
  const [model, setModel] = useState(settings?.models.chat ?? 'gpt-oss:20b')
  const [text, setText] = useState('')
  const [live, setLive] = useState<Live | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The stream we're showing, set as soon as chat:send returns (before its first chunk arrives).
  const streamRef = useRef<string | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // Threads for this project.
  const loadThreads = useCallback(async () => setThreads(await call('chat:threads', { projectId })), [projectId])
  useEffect(() => {
    let ok = true
    void call('chat:threads', { projectId }).then((t) => ok && setThreads(t))
    return () => {
      ok = false
    }
  }, [projectId])

  // Models from Ollama.
  const loadModels = useCallback(() => {
    call('chat:models').then(
      (m) => {
        setModels(m)
        setModelError(null)
      },
      (e: unknown) => {
        setModels([])
        setModelError(errorText(e))
      }
    )
  }, [])
  useEffect(() => {
    loadModels()
  }, [loadModels])

  // Streaming events from the main process.
  useEffect(() => {
    const offChunk = window.archai.on('chat:chunk', (c) => {
      setLive((l) => (l && l.streamId === c.streamId ? { ...l, content: l.content + (c.content ?? ''), thinking: l.thinking + (c.thinking ?? '') } : l))
    })
    const offDone = window.archai.on('chat:done', (d) => {
      if (streamRef.current !== d.streamId) return
      streamRef.current = null
      setMessages((m) => [...m, d.message])
      setLive(null)
    })
    const offErr = window.archai.on('chat:error', (e) => {
      if (streamRef.current !== e.streamId) return
      streamRef.current = null
      setError(e.message)
      setLive(null)
    })
    return () => {
      offChunk()
      offDone()
      offErr()
    }
  }, [])

  // Keep the newest text in view unless you've scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages, live])

  const open = async (t: Thread | null) => {
    if (live) return
    setError(null)
    setThreadId(t?.id ?? null)
    setMessages(t ? await call('chat:history', { threadId: t.id }) : [])
    if (t) setModel(t.model)
    stick.current = true
  }

  const send = async (raw = text) => {
    const body = raw.trim()
    if (!body || live || !activeProject) return
    setError(null)
    try {
      const r = await call('chat:send', { projectId, threadId, text: body, model })
      streamRef.current = r.streamId
      setText('')
      setMessages((m) => [...m, r.userMessage])
      setLive({ streamId: r.streamId, threadId: r.threadId, content: '', thinking: '' })
      stick.current = true
      if (threadId !== r.threadId) {
        setThreadId(r.threadId)
        void loadThreads()
      }
    } catch (e) {
      setError(errorText(e))
    }
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void send()
    }
  }

  const modelNames = models ? Array.from(new Set([...models.map((m) => m.name), model])) : [model]
  const current = threads.find((t) => t.id === threadId)
  const ctx = settings?.chat.contextLength ?? 8192

  return (
    <div className="chat" data-testid="chat">
      <aside className="chat__threads" aria-label="Chats in this project">
        <button type="button" className="btn chat__new" onClick={() => void open(null)} disabled={!!live} data-testid="chat-new">
          New chat
        </button>
        <ul>
          {threads.map((t) => (
            <li key={t.id}>
              <button type="button" aria-current={t.id === threadId ? 'true' : undefined} onClick={() => void open(t)} disabled={!!live && t.id !== threadId} title={t.title}>
                {t.title}
              </button>
            </li>
          ))}
        </ul>
        {threads.length === 0 && <p className="chat__none">No chats in this project yet.</p>}
      </aside>

      <section className="chat__main">
        <header className="chat__head">
          <h1 className="chat__title">{current?.title ?? 'New chat'}</h1>
          <div className="chat__controls">
            <label className="chat__model">
              <span className="field__hint">Model</span>
              <select className="input" value={model} onChange={(e) => setModel(e.target.value)} disabled={!!live} data-testid="model-picker">
                {modelNames.map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </label>
            <button type="button" className={`chat__ctx${ctx > CONTEXT_VRAM_WARNING ? ' chat__ctx--warn' : ''}`} onClick={() => setSection('settings')} title="Change in Settings">
              Context {ctx.toLocaleString('en-GB')}
            </button>
          </div>
        </header>
        {modelError && (
          <p className="chat__banner" role="alert">
            {modelError}{' '}
            <button type="button" className="btn btn--quiet" onClick={loadModels}>Try again</button>
          </p>
        )}

        <div
          className="chat__scroll"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
          }}
        >
          <div className="transcript" data-testid="transcript">
            {messages.length === 0 && !live && (
              <div className="chat__empty">
                <h2>Ask about {activeProject?.name}</h2>
                <p>Questions, drafts and checks for this project. Everything stays on this computer.</p>
                <div className="chat__examples">
                  {EXAMPLES.map((ex) => (
                    <button key={ex} type="button" className="example" onClick={() => setText(ex)}>
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m) => (
              <MessageView key={m.id} m={m} />
            ))}
            {live && (
              <article className="msg msg--assistant" aria-live="polite" data-testid="live">
                {live.thinking && (
                  <details className="reasoning" open={!live.content}>
                    <summary>{live.content ? 'Reasoning' : 'Thinking…'}</summary>
                    <p>{live.thinking}</p>
                  </details>
                )}
                {live.content ? <Markdown text={live.content} /> : !live.thinking && <p className="msg__waiting">Loading the model. The first reply can take a little while…</p>}
              </article>
            )}
            {error && (
              <p className="msg__error" role="alert" data-testid="chat-error">
                {error}
              </p>
            )}
          </div>
        </div>

        <div className="composer">
          <textarea
            className="composer__input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ask a question or paste a brief. Enter sends, Shift+Enter adds a line."
            rows={3}
            aria-label="Message"
            data-testid="composer"
          />
          {live ? (
            <button type="button" className="btn" onClick={() => void call('chat:cancel', { streamId: live.streamId })} data-testid="chat-stop">
              Stop
            </button>
          ) : (
            <button type="button" className="btn btn--primary" onClick={() => void send()} disabled={!text.trim()} data-testid="chat-send">
              Send
            </button>
          )}
        </div>
        <p className="composer__note">Answers come from a local model and can be wrong. Check regulations and structural figures against source documents.</p>
      </section>
    </div>
  )
}

function MessageView({ m }: { m: ChatMessage }) {
  if (m.role === 'user') {
    return (
      <article className="msg msg--user" data-testid="msg-user">
        <p>{m.content}</p>
      </article>
    )
  }
  return (
    <article className="msg msg--assistant" data-testid="msg-assistant">
      {m.thinking && (
        <details className="reasoning">
          <summary>Reasoning</summary>
          <p>{m.thinking}</p>
        </details>
      )}
      <Markdown text={m.content} />
      {Boolean(m.meta?.stopped || m.meta?.skills?.length) && (
        <p className="msg__meta">
          {m.meta?.stopped && 'Stopped before the end.'}
          {m.meta?.skills?.length ? ` Skills used: ${m.meta.skills.join(', ')}.` : ''}
        </p>
      )}
    </article>
  )
}
