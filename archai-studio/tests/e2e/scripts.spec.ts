import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFakeOllama } from '../fakes/fake-ollama'
import { launchApp, makeDirs } from './launch'

const LISP_V1 = '(defun c:RAREA (/ ss)\n  (vl-load-com)\n  (princ "\\nVersion one")\n  (princ))'
const LISP_V2 = '(defun c:RAREA (/ ss)\n  (vl-load-com)\n  (princ "\\nVersion two fixed")\n  (princ))'

function replyFor(user: string, system: string): string[] {
  if (!system.includes('AutoLISP')) return ['```python\nOUT = "wrong target"\n```']
  if (user.startsWith('Explain')) return ['This script defines the **RAREA** command. ', 'It only prints a message.']
  if (user.includes('fails in')) return ['The variable was misspelt.\n\n', '```lisp\n' + LISP_V2 + '\n```\n\n**Notes**\n- Fixed.']
  return ['Here is the script.\n\n```lisp\n', LISP_V1, '\n```\n\n**Notes**\n- Type RAREA to run. Drawing units: mm.']
}

test('Script Studio generates, explains, fixes and saves an AutoLISP script', async () => {
  const ollama = await startFakeOllama({ replyFor })
  const d = makeDirs()
  const app = await launchApp({ dirs: d, seed: { firstRunComplete: true, endpoints: { ollama: ollama.url, comfy: 'http://127.0.0.1:9' } } })
  const page = await app.firstWindow()
  await page.getByTestId('project-name').fill('Kandy Courtyard House')
  await page.getByTestId('project-create').click()
  await page.getByTestId('nav-scripts').click()

  await expect(page.getByTestId('review-banner')).toContainText('never runs scripts')
  await page.getByTestId('target-autolisp').click()
  await expect(page.getByTestId('target-autolisp')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('script-save')).toHaveText('Save as .lsp')

  await page.getByTestId('script-task').fill('Label closed polylines with their area in m²')
  await page.getByTestId('script-generate').click()
  const editor = page.getByTestId('editor')
  await expect(editor.locator('.view-lines')).toContainText('Version one')
  await expect(page.getByTestId('script-notes')).toContainText('Type RAREA to run')
  await expect(page.getByTestId('script-notes')).not.toContainText('defun')

  // The system prompt for the chosen target reached Ollama.
  const body = JSON.parse(ollama.requests.filter((r) => r.path === '/api/chat').at(-1)!.body)
  expect(body.messages[0].content).toContain('vla-StartUndoMark')
  expect(body.messages.at(-1).content).toContain('Write an AutoLISP script for AutoCAD')

  await page.getByTestId('script-copy').click()
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toContain('Version one')

  await page.getByTestId('script-explain').click()
  await expect(page.getByTestId('script-notes')).toContainText('defines the RAREA command')
  await expect(editor.locator('.view-lines')).toContainText('Version one')

  await page.getByTestId('script-fix-open').click()
  await page.getByTestId('script-traceback').fill('; error: bad argument type: numberp: nil')
  await page.getByTestId('script-fix').click()
  await expect(editor.locator('.view-lines')).toContainText('Version two fixed')
  const fixReq = JSON.parse(ollama.requests.filter((r) => r.path === '/api/chat').at(-1)!.body)
  expect(fixReq.messages.at(-1).content).toContain('bad argument type')
  expect(fixReq.messages.at(-1).content).toContain('Version one')

  // Save with a stubbed dialog.
  const file = join(d.root, 'rarea.lsp')
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: f })) as typeof dialog.showSaveDialog
  }, file)
  await page.getByTestId('script-save').click()
  await expect(page.getByTestId('toast')).toContainText('Saved rarea.lsp')
  const saved = readFileSync(file, 'utf8')
  expect(saved).toContain('Version two fixed')
  expect(saved).toContain('\r\n')
  await expect(page.getByRole('button', { name: /Label closed polylines/ })).toBeVisible()

  await app.close()
  await ollama.close()
})
