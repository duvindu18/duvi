import { describe, expect, it } from 'vitest'
import { extractCode, scriptFileName, SCRIPT_TARGETS, TARGETS } from '@shared/scripts'
import { openDatabase } from '../../src/main/db/database'
import { ProjectsRepo } from '../../src/main/db/projects-repo'
import { ScriptsRepo } from '../../src/main/db/scripts-repo'
import { explainMessage, fixMessage, generateMessage, scriptSystemPrompt } from '../../src/main/features/scripts'

describe('Script Studio prompts', () => {
  it.each(SCRIPT_TARGETS)('%s has common rules, its own conventions and a known-good example', (t) => {
    const p = scriptSystemPrompt(t)
    expect(p).toContain('exactly one')
    expect(p).toContain('Never delete elements')
    expect(p).toContain('Known-good example')
    expect(p).toContain('```' + (TARGETS[t].fence === 'lisp' ? 'lisp' : TARGETS[t].fence))
  })

  it('carries the key API conventions per target', () => {
    expect(scriptSystemPrompt('dynamo')).toContain('TransactionManager.Instance.EnsureInTransaction')
    expect(scriptSystemPrompt('dynamo')).toContain('UnwrapElement')
    expect(scriptSystemPrompt('pyrevit')).toContain('with revit.Transaction')
    expect(scriptSystemPrompt('grasshopper')).toContain('#! python3')
    expect(scriptSystemPrompt('autolisp')).toContain('vla-StartUndoMark')
    expect(scriptSystemPrompt('blender')).toContain('bpy.data')
    expect(scriptSystemPrompt('officescript')).toContain('function main(workbook: ExcelScript.Workbook)')
  })

  it('builds explain and fix messages around the code', () => {
    expect(generateMessage('autolisp', ' total wall length ')).toBe('Write an AutoLISP script for AutoCAD.\n\nTask: total wall length')
    expect(generateMessage('dynamo', 'x')).toMatch(/^Write a Dynamo Python script for Revit/)
    expect(explainMessage('dynamo', 'OUT = 1\n')).toContain('```python\nOUT = 1\n```')
    const fix = fixMessage('pyrevit', 'x = 1', "NameError: name 'doc' is not defined")
    expect(fix).toContain("NameError: name 'doc' is not defined")
    expect(fix).toContain('```python\nx = 1\n```')
  })
})

describe('code extraction', () => {
  it('takes the expected-language block and keeps the rest as notes', () => {
    const reply = 'Here you go.\n\n```text\nignore\n```\n\n```python\nOUT = 42\n```\n\n**Notes**\n- Read only.'
    const r = extractCode(reply, 'python')
    expect(r.code).toBe('OUT = 42\n')
    expect(r.notes).toContain('**Notes**')
    expect(r.notes).not.toContain('OUT = 42')
  })

  it('accepts common aliases', () => {
    expect(extractCode('```autolisp\n(princ)\n```', 'lisp').code).toBe('(princ)\n')
    expect(extractCode('```ts\nfunction main() {}\n```', 'typescript').code).toBe('function main() {}\n')
  })

  it('falls back to the first block, or none', () => {
    expect(extractCode('```\nprint(1)\n```', 'python').code).toBe('print(1)\n')
    expect(extractCode('No code, sorry.', 'python')).toEqual({ code: null, notes: 'No code, sorry.' })
  })

  it('makes safe file names', () => {
    expect(scriptFileName('Label rooms: area (m²)!', 'lsp')).toBe('label-rooms-area-m.lsp')
    expect(scriptFileName('***', 'py')).toBe('script.py')
  })
})

describe('saved scripts', () => {
  it('are kept per project', () => {
    const db = openDatabase(':memory:')
    const projects = new ProjectsRepo(db)
    const a = projects.create('A')
    const b = projects.create('B')
    const repo = new ScriptsRepo(db)
    repo.add(a.id, 'autolisp', 'Area labels', '(princ)', 'C:\\x.lsp')
    expect(repo.list(a.id)).toHaveLength(1)
    expect(repo.list(b.id)).toHaveLength(0)
    expect(repo.list(a.id)[0]!.target).toBe('autolisp')
  })
})
