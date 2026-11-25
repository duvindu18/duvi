import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { createEditor, monaco, refreshEditorTheme } from '../../components/monaco'

export interface ScriptEditorHandle {
  getValue(): string
  setValue(v: string): void
}

export const ScriptEditor = forwardRef<ScriptEditorHandle, { language: string; theme: string; onChange?: (v: string) => void }>(function ScriptEditor(
  { language, theme, onChange },
  ref
) {
  const host = useRef<HTMLDivElement>(null)
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const changeRef = useRef(onChange)
  useEffect(() => {
    changeRef.current = onChange
  }, [onChange])

  useEffect(() => {
    if (!host.current) return
    const e = createEditor(host.current, '', language)
    ed.current = e
    const sub = e.onDidChangeModelContent(() => changeRef.current?.(e.getValue()))
    return () => {
      sub.dispose()
      e.getModel()?.dispose()
      e.dispose()
      ed.current = null
    }
    // The editor is created once; language and theme are updated below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const model = ed.current?.getModel()
    if (model) monaco.editor.setModelLanguage(model, language)
  }, [language])

  useEffect(() => {
    refreshEditorTheme()
  }, [theme])

  useImperativeHandle(ref, () => ({
    getValue: () => ed.current?.getValue() ?? '',
    setValue: (v: string) => {
      const e = ed.current
      if (!e) return
      // Keep it undoable with Ctrl+Z.
      e.executeEdits('archai', [{ range: e.getModel()!.getFullModelRange(), text: v }])
      e.pushUndoStop()
      e.setScrollTop(0)
    }
  }))

  return <div className="editor" ref={host} data-testid="editor" />
})
