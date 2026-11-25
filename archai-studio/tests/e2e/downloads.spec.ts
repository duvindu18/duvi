import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startFakeComfy } from '../fakes/fake-comfy'
import { startFakeInternet } from '../fakes/fake-internet'
import { startFakeOllama } from '../fakes/fake-ollama'
import { launchApp, makeDirs } from './launch'

test('setup downloads the chat model through Ollama and SDXL into your ComfyUI, with checksums', async () => {
  const sdxl = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251))
  const net = await startFakeInternet({
    github: {},
    hf: {
      'stabilityai/stable-diffusion-xl-base-1.0': { 'sd_xl_base_1.0.safetensors': { bytes: sdxl } },
      'xinsir/controlnet-canny-sdxl-1.0': { 'diffusion_pytorch_model.safetensors': { bytes: Buffer.from('controlnet') } }
    }
  })
  const ollama = await startFakeOllama({ models: [] })
  const comfy = await startFakeComfy()
  const d = makeDirs()
  const myComfy = join(d.root, 'MyComfyUI')
  mkdirSync(join(myComfy, 'models', 'checkpoints'), { recursive: true })

  const app = await launchApp({
    dirs: d,
    seed: { endpoints: { ollama: ollama.url, comfy: comfy.url } },
    env: { ARCHAI_TEST_DOWNLOAD_ORIGIN: net.url }
  })
  const page = await app.firstWindow()
  await page.getByTestId('wizard-next').click() // welcome
  await page.getByTestId('wizard-next').click() // folders

  const panel = page.getByTestId('downloads')
  await expect(panel).toBeVisible()
  // Ollama and ComfyUI are already running, so they count as installed.
  await expect(page.getByTestId('dl-ollama-app')).toHaveAttribute('data-state', 'installed')
  await expect(page.getByTestId('dl-comfyui')).toHaveAttribute('data-state', 'installed')
  await expect(page.getByTestId('dl-gpt-oss-20b')).toHaveAttribute('data-state', 'missing')
  // Flux is optional and not ticked by default.
  await expect(page.getByTestId('dl-flux-schnell').locator('input')).not.toBeChecked()

  // Image models need to know where ComfyUI keeps its models.
  await expect(page.getByTestId('dl-sdxl-base')).toHaveAttribute('data-state', 'unknown')
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog
  }, myComfy)
  await page.getByTestId('choose-comfy').click()
  await expect(page.getByTestId('dl-sdxl-base')).toHaveAttribute('data-state', 'missing')

  await page.getByTestId('dl-nomic-embed').locator('input').uncheck()
  await expect(page.getByTestId('dl-space')).toContainText('Needs about')
  await page.getByTestId('dl-start').click()
  for (const id of ['gpt-oss-20b', 'sdxl-base', 'sdxl-canny']) {
    await expect(page.getByTestId(`dl-${id}`)).toHaveAttribute('data-state', 'installed', { timeout: 20_000 })
  }
  await expect(page.getByTestId('toast')).toContainText('Everything you chose is installed')

  const saved = join(myComfy, 'models', 'checkpoints', 'sd_xl_base_1.0.safetensors')
  expect(createHash('sha256').update(readFileSync(saved)).digest('hex')).toBe(createHash('sha256').update(sdxl).digest('hex'))
  expect(existsSync(join(myComfy, 'models', 'controlnet', 'xinsir-controlnet-canny-sdxl-1.0.safetensors'))).toBe(true)
  expect(ollama.requests.some((r) => r.path === '/api/pull')).toBe(true)
  await app.close()
  await Promise.all([net.close(), ollama.close(), comfy.close()])
})
