import { memo, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { call } from '../lib/ipc'

function CodeBlock({ code, lang }: { code: string; lang: string | null }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="codeblock">
      <div className="codeblock__bar">
        <span>{lang ?? 'text'}</span>
        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => {
            void call('clipboard:writeText', { text: code }).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

const components: Components = {
  // Raw HTML is never rendered (react-markdown's default). Links open in the browser only on click.
  a: ({ href, children }) =>
    href?.startsWith('https://') ? (
      <a href={href} target="_blank" rel="noreferrer">{children}</a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => <span className="md-img">[image: {alt}]</span>,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? '')
    const lang = /language-([\w+-]+)/.exec(className ?? '')?.[1] ?? null
    if (!lang && !text.includes('\n')) return <code className="md-code">{children}</code>
    return <CodeBlock code={text.replace(/\n$/, '')} lang={lang} />
  },
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  )
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
