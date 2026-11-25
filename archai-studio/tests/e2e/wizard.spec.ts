import { expect, test } from '@playwright/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { startFakeComfy } from '../fakes/fake-comfy'
import { startFakeOllama } from '../fakes/fake-ollama'
import { launchApp, makeDirs } from './launch'

test('first-run wizard reports a stopped Ollama, then goes green when it starts', async () => {
  const comfy = await startFakeComfy()
  // Reserve a port for Ollama, then stop it so nothing answers there.
  const probe = await startFakeOllama()
  const ollamaPort = probe.port
  await probe.close()

  const d = makeDirs()
  const seed = { endpoints: { ollama: `http://127.0.0.1:${ollamaPort}`, comfy: comfy.url } }
  const app = await launchApp({ dirs: d, seed })
  const page = await app.firstWindow()

  await expect(page.getByTestId('wizard')).toBeVisible()
  await page.getByTestId('wizard-next').click()

  // Folders: the default data folder, plus an optional gallery folder on another drive.
  await expect(page.getByTestId('wizard-data-folder')).toHaveText(d.data)
  const gallery = join(d.root, 'D-drive', 'ArchAI Gallery')
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog
  }, gallery)
  await page.getByTestId('gallery-toggle').click()
  await expect(page.getByTestId('wizard-gallery-folder')).toHaveText(gallery)
  await page.getByTestId('wizard-next').click()

  // Downloads step: shown, but skipped here (covered by downloads.spec.ts).
  await expect(page.getByTestId('downloads')).toBeVisible()
  await page.getByTestId('wizard-next').click()

  const ollama = page.getByTestId('check-ollama')
  await expect(ollama).toHaveAttribute('data-status', 'fail')
  await expect(ollama).toContainText("Ollama isn't running")
  await expect(ollama).toContainText('ollama serve')
  await expect(page.getByTestId('check-comfy')).toHaveAttribute('data-status', 'ok')
  await expect(page.getByTestId('wizard-next')).toHaveText('Continue anyway')

  await page.getByTestId('copy-ollama').click()
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('ollama serve')

  // Start Ollama and check again.
  const ollamaUp = await startFakeOllama({ port: ollamaPort })
  await page.getByTestId('check-again').click()
  await expect(ollama).toHaveAttribute('data-status', 'ok')
  await expect(page.getByTestId('check-model')).toHaveAttribute('data-status', 'ok')
  await expect(page.getByTestId('wizard-next')).toHaveText('Continue')

  // No database has been written to the data folder yet.
  expect(existsSync(join(d.data, 'archai.db'))).toBe(false)

  await page.getByTestId('wizard-next').click()
  await page.getByTestId('wizard-next').click()
  await expect(page.getByTestId('start-project')).toBeVisible()
  await expect(page.getByTestId('tb-ollama')).toHaveText('Running')
  await expect(page.getByTestId('tb-comfy')).toHaveText('Running')
  expect(existsSync(join(d.data, 'archai.db'))).toBe(true)
  await app.close()

  // Setup is remembered.
  const again = await launchApp({ dirs: d, seed: null })
  const p2 = await again.firstWindow()
  await expect(p2.getByTestId('start-project')).toBeVisible()
  await expect(p2.getByTestId('wizard')).toHaveCount(0)
  await again.close()

  await ollamaUp.close()
  await comfy.close()
})

test('the title block and Settings checks show when ComfyUI is stopped', async () => {
  const ollama = await startFakeOllama()
  const app = await launchApp({ seed: { firstRunComplete: true, endpoints: { ollama: ollama.url, comfy: 'http://127.0.0.1:9' } } })
  const page = await app.firstWindow()
  await expect(page.getByTestId('tb-ollama')).toHaveText('Running')
  await expect(page.getByTestId('tb-comfy')).toHaveText('Not running')

  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-run-checks').click()
  await expect(page.getByTestId('check-comfy')).toHaveAttribute('data-status', 'fail')
  await expect(page.getByTestId('check-comfy')).toContainText("ComfyUI isn't running")
  await app.close()
  await ollama.close()
})
