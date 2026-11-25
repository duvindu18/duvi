/**
 * Script Studio prompts. Generation, explanation and fixes all go through the
 * chat service (kind "script"), each target with its own system prompt.
 * The app never runs these scripts.
 */
import common from '../../../resources/prompts/scripts/_common.md?raw'
import autolisp from '../../../resources/prompts/scripts/autolisp.md?raw'
import blender from '../../../resources/prompts/scripts/blender.md?raw'
import dynamo from '../../../resources/prompts/scripts/dynamo.md?raw'
import grasshopper from '../../../resources/prompts/scripts/grasshopper.md?raw'
import officescript from '../../../resources/prompts/scripts/officescript.md?raw'
import pyrevit from '../../../resources/prompts/scripts/pyrevit.md?raw'
import { TARGETS, type ScriptTarget } from '@shared/scripts'

const TARGET_PROMPTS: Record<ScriptTarget, string> = { dynamo, pyrevit, grasshopper, autolisp, blender, officescript }

export function scriptSystemPrompt(target: ScriptTarget): string {
  return `${common.trim()}\n\n${TARGET_PROMPTS[target].trim()}\n`
}

const fenced = (code: string, fence: string) => `\`\`\`${fence}\n${code.replace(/\s+$/, '')}\n\`\`\``

export function generateMessage(target: ScriptTarget, task: string): string {
  const t = TARGETS[target]
  const article = /^[aeiou]/i.test(t.name) ? 'an' : 'a'
  return `Write ${article} ${t.name} script for ${t.program}.\n\nTask: ${task.trim()}`
}

export function explainMessage(target: ScriptTarget, code: string): string {
  const t = TARGETS[target]
  return `Explain this ${t.name} script for ${t.program} in plain language, section by section. Point out anything risky. Don't rewrite it.\n\n${fenced(code, t.fence)}`
}

export function fixMessage(target: ScriptTarget, code: string, error: string): string {
  const t = TARGETS[target]
  return `This ${t.name} script fails in ${t.program}. Explain the cause briefly, then give the complete corrected script.\n\nScript:\n${fenced(code, t.fence)}\n\nError:\n\`\`\`text\n${error.trim()}\n\`\`\``
}
