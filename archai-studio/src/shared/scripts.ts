import { z } from 'zod'

export const SCRIPT_TARGETS = ['dynamo', 'pyrevit', 'grasshopper', 'autolisp', 'blender', 'officescript'] as const
export type ScriptTarget = (typeof SCRIPT_TARGETS)[number]

export interface TargetInfo {
  id: ScriptTarget
  name: string
  program: string
  ext: string
  /** Monaco language id. */
  language: 'python' | 'autolisp' | 'typescript'
  /** Fence tag the model is asked to use. */
  fence: string
  example: string
}

export const TARGETS: Record<ScriptTarget, TargetInfo> = {
  dynamo: { id: 'dynamo', name: 'Dynamo Python', program: 'Revit', ext: 'py', language: 'python', fence: 'python', example: 'List all doors with their level, width and fire rating.' },
  pyrevit: { id: 'pyrevit', name: 'pyRevit', program: 'Revit', ext: 'py', language: 'python', fence: 'python', example: 'A button that renumbers selected rooms from left to right.' },
  grasshopper: { id: 'grasshopper', name: 'Grasshopper Python', program: 'Rhino 8', ext: 'py', language: 'python', fence: 'python', example: 'A perforated jali screen on a surface, with hole size by sun exposure.' },
  autolisp: { id: 'autolisp', name: 'AutoLISP', program: 'AutoCAD', ext: 'lsp', language: 'autolisp', fence: 'lisp', example: 'Total the length of all polylines on layer A-WALL in metres.' },
  blender: { id: 'blender', name: 'Blender Python', program: 'Blender', ext: 'py', language: 'python', fence: 'python', example: 'A pergola of timber battens over a courtyard, with spacing in mm.' },
  officescript: { id: 'officescript', name: 'Office Script', program: 'Excel', ext: 'ts', language: 'typescript', fence: 'typescript', example: 'An area schedule that groups rooms by floor and totals each floor.' }
}

const Target = z.enum(SCRIPT_TARGETS)
const Base = { projectId: z.number().int().positive(), target: Target, threadId: z.number().int().positive().nullable(), model: z.string().trim().min(1).max(200) }
const Code = z.string().max(200_000, 'That script is too long for the model to read.')

export const ScriptGenerateSchema = z.object({ ...Base, task: z.string().trim().min(1, 'Describe what the script should do.').max(20_000) }).strict()
export const ScriptExplainSchema = z.object({ ...Base, code: Code.min(1, 'There is no script to explain yet.') }).strict()
export const ScriptFixSchema = z.object({ ...Base, code: Code, error: z.string().trim().min(1, 'Paste the error message first.').max(40_000) }).strict()
export const ScriptSaveSchema = z
  .object({ projectId: z.number().int().positive(), target: Target, title: z.string().trim().min(1).max(120), code: Code.min(1, 'There is no script to save yet.') })
  .strict()

export type ScriptGenerate = z.input<typeof ScriptGenerateSchema>
export type ScriptExplain = z.input<typeof ScriptExplainSchema>
export type ScriptFix = z.input<typeof ScriptFixSchema>
export type ScriptSave = z.input<typeof ScriptSaveSchema>

export interface SavedScript {
  id: number
  projectId: number
  target: ScriptTarget
  title: string
  code: string
  path: string | null
  createdAt: string
}

/** Pulls the script out of a model reply: the first fenced block, preferring the expected language. */
export function extractCode(reply: string, fence: string): { code: string | null; notes: string } {
  const re = /```([\w+-]*)[^\n]*\n([\s\S]*?)```/g
  let first: RegExpExecArray | null = null
  let preferred: RegExpExecArray | null = null
  for (let m = re.exec(reply); m; m = re.exec(reply)) {
    first ??= m
    const tag = (m[1] ?? '').toLowerCase()
    if (!preferred && (tag === fence || (fence === 'lisp' && /^(lisp|autolisp|lsp|scheme)$/.test(tag)) || (fence === 'typescript' && tag === 'ts') || (fence === 'python' && tag === 'py'))) preferred = m
  }
  const m = preferred ?? first
  if (!m) return { code: null, notes: reply.trim() }
  const notes = (reply.slice(0, m.index) + reply.slice(m.index + m[0].length)).trim()
  return { code: (m[2] ?? '').replace(/\s+$/, '') + '\n', notes }
}

/** A safe default file name from the task. */
export function scriptFileName(title: string, ext: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `${base || 'script'}.${ext}`
}
