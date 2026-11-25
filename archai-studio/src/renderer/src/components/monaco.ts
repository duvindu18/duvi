/**
 * Monaco, bundled with the app (no CDN). Only the core editor and the
 * syntax colouring for Python, TypeScript and a small AutoLISP grammar are loaded;
 * no language servers, so it works offline and loads fast.
 */
import 'monaco-editor/esm/vs/editor/editor.all.js'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js'
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution.js'
import 'monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js'
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker.js?worker'

// Monaco's own typings declare window.MonacoEnvironment.
self.MonacoEnvironment = { getWorker: () => new EditorWorker() }

monaco.languages.register({ id: 'autolisp', extensions: ['.lsp'], aliases: ['AutoLISP'] })
monaco.languages.setLanguageConfiguration('autolisp', {
  comments: { lineComment: ';' },
  brackets: [['(', ')']],
  autoClosingPairs: [
    { open: '(', close: ')' },
    { open: '"', close: '"' }
  ]
})
monaco.languages.setMonarchTokensProvider('autolisp', {
  ignoreCase: true,
  keywords: ['defun', 'setq', 'if', 'progn', 'while', 'repeat', 'foreach', 'cond', 'lambda', 'and', 'or', 'not', 'princ', 'command', 'vl-load-com'],
  tokenizer: {
    root: [
      [/;.*$/, 'comment'],
      [/"([^"\\]|\\.)*"/, 'string'],
      [/'[\w*-]+/, 'type'],
      [/-?\d+(\.\d+)?([eE][-+]?\d+)?/, 'number'],
      [/c:[\w-]+/, 'type.identifier'],
      [/(vla|vlax|vlr|vl)-[\w-]+/, 'predefined'],
      [/[\w*+\-/<>=!?.]+/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
      [/[()]/, '@brackets']
    ]
  }
})

/** Editor colours follow the app's theme tokens. */
function defineThemes(): void {
  const css = getComputedStyle(document.documentElement)
  const v = (n: string) => css.getPropertyValue(n).trim() || '#000000'
  const dark = document.documentElement.dataset.theme !== 'light'
  monaco.editor.defineTheme('archai', {
    base: dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [{ token: 'comment', foreground: v('--text-3').replace('#', ''), fontStyle: 'italic' }],
    colors: {
      'editor.background': v('--bg'),
      'editor.foreground': v('--text'),
      'editorLineNumber.foreground': v('--text-3'),
      'editorLineNumber.activeForeground': v('--text-2'),
      'editor.lineHighlightBackground': v('--surface'),
      'editor.selectionBackground': v('--line-strong'),
      'editorCursor.foreground': v('--accent'),
      'editorIndentGuide.background1': v('--line')
    }
  })
}

export function createEditor(el: HTMLElement, value: string, language: string, readOnly = false): monaco.editor.IStandaloneCodeEditor {
  defineThemes()
  return monaco.editor.create(el, {
    value,
    language,
    theme: 'archai',
    readOnly,
    automaticLayout: true,
    minimap: { enabled: false },
    fontFamily: "'JetBrains Mono', Consolas, monospace",
    fontSize: 13,
    lineHeight: 20,
    scrollBeyondLastLine: false,
    renderLineHighlight: 'line',
    tabSize: 4,
    wordWrap: 'off',
    padding: { top: 12, bottom: 12 },
    bracketPairColorization: { enabled: false },
    // No telemetry, links or web lookups in the editor.
    links: false,
    hover: { enabled: false },
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    parameterHints: { enabled: false }
  })
}

export function refreshEditorTheme(): void {
  defineThemes()
  monaco.editor.setTheme('archai')
}

export { monaco }
