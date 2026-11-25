import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makePng, startFakeComfy } from '../fakes/fake-comfy'
import { startFakeOllama } from '../fakes/fake-ollama'
import { launchApp, makeDirs, type Dirs } from './launch'

async function open(d: Dirs, ollamaUrl: string, comfyUrl: string, first = true): Promise<[ElectronApplication, Page]> {
  const app = await launchApp({ dirs: d, seed: first ? { firstRunComplete: true, endpoints: { ollama: ollamaUrl, comfy: comfyUrl } } : null })
  const page = await app.firstWindow()
  return [app, page]
}

const stubOpen = (app: ElectronApplication, file: string) =>
  app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog
  }, file)

test('text to image: progress, gallery with metadata, persists after restart', async () => {
  const comfy = await startFakeComfy({ steps: 6, stepDelayMs: 40 })
  const ollama = await startFakeOllama({ reply: ['{"prompt":"two-storey courtyard house, clay tile roof, Kandy hills, late afternoon light","negative":"snow"}'] })
  const d = makeDirs()
  let [app, page] = await open(d, ollama.url, comfy.url)
  await page.getByTestId('project-name').fill('Kandy Courtyard House')
  await page.getByTestId('project-create').click()
  await page.getByTestId('nav-visual').click()

  // Model list comes from ComfyUI.
  await page.getByText('Advanced').click()
  await expect(page.getByTestId('checkpoint-picker').locator('option')).toHaveText(['sd_xl_base_1.0.safetensors', 'juggernautXL_v9.safetensors'])
  await page.getByTestId('checkpoint-picker').selectOption('juggernautXL_v9.safetensors')

  await page.getByTestId('image-description').fill('courtyard house on a slope')
  await page.getByTestId('preset-bawa-courtyard').click()
  await expect(page.getByTestId('prompt-positive')).toHaveValue(/courtyard house on a slope, courtyard house inspired by Geoffrey Bawa/)

  // Prompt helper (gpt-oss) rewrites the prompt.
  await page.getByTestId('prompt-helper').click()
  await expect(page.getByTestId('prompt-positive')).toHaveValue('two-storey courtyard house, clay tile roof, Kandy hills, late afternoon light')
  await expect(page.getByTestId('prompt-negative')).toHaveValue(/snow/)

  await page.getByTestId('seed').fill('424242')
  await page.getByTestId('image-generate').click()
  await expect(page.getByTestId('image-progress')).toContainText(/Rendering, step \d of 6/)
  await expect(page.getByTestId('tb-gpu')).toHaveText('Image models loaded')
  const latest = page.getByTestId('latest').locator('img')
  await expect(latest).toBeVisible()
  await expect.poll(() => latest.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(64)

  const sent = comfy.prompts[0]!.prompt
  expect(sent['3']!.inputs.seed).toBe(424242)
  expect(sent['4']!.inputs.ckpt_name).toBe('juggernautXL_v9.safetensors')

  await latest.click()
  await expect(page.getByTestId('detail-seed')).toHaveText('424242')
  await page.keyboard.press('Escape')

  await app.close()
  ;[app, page] = await open(d, ollama.url, comfy.url, false)
  await page.getByTestId('nav-visual').click()
  await expect(page.getByTestId('gallery').locator('img')).toHaveCount(1)
  // The checkpoint choice was remembered.
  await page.getByText('Advanced').click()
  await expect(page.getByTestId('checkpoint-picker')).toHaveValue('juggernautXL_v9.safetensors')
  await app.close()
  await comfy.close()
  await ollama.close()
})

test('sketch to render uploads the sketch, and a gallery image can be varied', async () => {
  const comfy = await startFakeComfy()
  const d = makeDirs()
  const [app, page] = await open(d, 'http://127.0.0.1:9', comfy.url)
  await page.getByTestId('project-name').fill('Galle Fort Hotel')
  await page.getByTestId('project-create').click()
  await page.getByTestId('nav-visual').click()
  await page.getByTestId('mode-sketch').click()
  await expect(page.getByTestId('image-generate')).toBeDisabled()

  const sketch = join(d.root, 'massing.png')
  writeFileSync(sketch, makePng(1600, 900))
  await stubOpen(app, sketch)
  await page.getByTestId('pick-input').click()
  await expect(page.locator('.inputimg img')).toBeVisible()
  await page.getByTestId('image-description').fill('boutique hotel in a Dutch-period street, lime-washed walls')
  await page.getByTestId('image-generate').click()
  await expect(page.getByTestId('latest').locator('img')).toBeVisible()
  expect(comfy.uploads).toHaveLength(1)
  const sent = comfy.prompts[0]!.prompt
  expect(sent['10']!.inputs.image).toBe(comfy.uploads[0])
  expect(sent['12']!.inputs.control_net_name).toBe('controlnet-canny-sdxl-1.0.safetensors')
  expect([sent['5']!.inputs.width, sent['5']!.inputs.height]).toEqual([1344, 768])

  // Vary the result straight from the gallery.
  await page.getByTestId('latest').click()
  await page.getByTestId('detail-vary').click()
  await expect(page.getByTestId('mode-variation')).toHaveAttribute('aria-pressed', 'true')
  await page.getByTestId('image-generate').click()
  await expect(page.getByTestId('gallery').locator('img')).toHaveCount(2)
  expect(comfy.prompts[1]!.prompt['3']!.inputs.denoise).toBe(0.55)
  await app.close()
  await comfy.close()
})

test('importing a ComfyUI workflow: editor format is explained, API format is mapped', async () => {
  const comfy = await startFakeComfy()
  const d = makeDirs()
  const [app, page] = await open(d, 'http://127.0.0.1:9', comfy.url)
  await page.getByTestId('project-name').fill('Negombo Villa')
  await page.getByTestId('project-create').click()
  await page.getByTestId('nav-visual').click()
  await page.getByText('Advanced').click()

  const uiFile = join(d.root, 'ui.json')
  writeFileSync(uiFile, JSON.stringify({ nodes: [], links: [] }))
  await stubOpen(app, uiFile)
  await page.getByTestId('import-workflow').click()
  await expect(page.getByTestId('import-dialog')).toContainText('Export (API)')
  await page.getByTestId('import-dialog').getByRole('button', { name: 'Cancel' }).click()

  const apiFile = join(d.root, 'My SDXL lightning.json')
  writeFileSync(apiFile, readFileSync('resources/workflows/sdxl-text.json'))
  await stubOpen(app, apiFile)
  await page.getByTestId('import-workflow').click()
  await page.getByTestId('import-save').click()
  await expect(page.getByTestId('toast')).toContainText('Imported My SDXL lightning')
  await expect(page.getByTestId('workflow-picker')).toHaveValue(/^user-/)
  await page.getByTestId('image-description').fill('test')
  await page.getByTestId('image-generate').click()
  await expect(page.getByTestId('latest').locator('img')).toBeVisible()
  await app.close()
  await comfy.close()
})

test('a stopped ComfyUI is explained, and chat still works', async () => {
  const d = makeDirs()
  const [app, page] = await open(d, 'http://127.0.0.1:9', 'http://127.0.0.1:9')
  await page.getByTestId('project-name').fill('Jaffna School')
  await page.getByTestId('project-create').click()
  await page.getByTestId('nav-visual').click()
  await expect(page.getByTestId('comfy-down')).toContainText("ComfyUI isn't running")
  await page.getByTestId('image-description').fill('a school courtyard')
  await page.getByTestId('image-generate').click()
  await expect(page.getByTestId('image-error')).toContainText("ComfyUI isn't running")
  await app.close()
})
