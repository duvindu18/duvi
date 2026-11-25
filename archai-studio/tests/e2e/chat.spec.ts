import { expect, test } from '@playwright/test'
import { startFakeOllama } from '../fakes/fake-ollama'
import { launchApp, makeDirs } from './launch'

const markdownReply = ['## Roof', '\n\nUse a **35°** pitch.', '\n\n| Item | Area |\n|---|---|\n| Living | 42 m² |\n', '\n> Check this against the current source documents.']

test('chat streams a reply, shows markdown, and keeps history per project', async () => {
  const ollama = await startFakeOllama({ reply: markdownReply, thinking: ['Monsoon rain', ' needs a steep roof.'], models: ['gpt-oss:20b', 'qwen3:14b', 'nomic-embed-text:latest'] })
  const d = makeDirs()
  const seed = { firstRunComplete: true, endpoints: { ollama: ollama.url, comfy: 'http://127.0.0.1:9' } }
  let app = await launchApp({ dirs: d, seed })
  let page = await app.firstWindow()
  await page.getByTestId('project-name').fill('Kandy Courtyard House')
  await page.getByTestId('project-create').click()
  await expect(page.getByTestId('chat')).toBeVisible()

  // Model picker comes from Ollama; embedding models are left out.
  const picker = page.getByTestId('model-picker')
  await expect(picker.locator('option')).toHaveText(['gpt-oss:20b', 'qwen3:14b'])
  await expect(picker).toHaveValue('gpt-oss:20b')

  await page.getByTestId('composer').fill('What roof pitch for clay tiles in Kandy?')
  await page.getByTestId('composer').press('Enter')
  await expect(page.getByTestId('msg-user')).toHaveText('What roof pitch for clay tiles in Kandy?')
  const reply = page.getByTestId('msg-assistant')
  await expect(reply.getByRole('heading', { name: 'Roof' })).toBeVisible()
  await expect(reply.locator('strong')).toHaveText('35°')
  await expect(reply.locator('table')).toContainText('42 m²')
  await expect(reply.locator('blockquote')).toContainText('Check this against')
  await expect(reply.locator('summary')).toHaveText('Reasoning')

  // Ollama received the context length and the practice system prompt.
  const sent = JSON.parse(ollama.requests.filter((r) => r.path === '/api/chat').at(-1)!.body)
  expect(sent.options.num_ctx).toBe(8192)
  expect(sent.messages[0].content).toContain('Sri Lanka')

  await app.close()
  app = await launchApp({ dirs: d, seed: null })
  page = await app.firstWindow()
  await page.getByRole('button', { name: 'What roof pitch for clay tiles in Kandy?' }).click()
  await expect(page.getByTestId('msg-assistant').locator('table')).toContainText('42 m²')
  await app.close()
  await ollama.close()
})

test('Stop ends a reply early and keeps what was written', async () => {
  const ollama = await startFakeOllama({ reply: Array.from({ length: 200 }, (_, i) => `word${i} `), tokenDelayMs: 25 })
  const app = await launchApp({ seed: { firstRunComplete: true, endpoints: { ollama: ollama.url, comfy: 'http://127.0.0.1:9' } } })
  const page = await app.firstWindow()
  await page.getByTestId('project-name').fill('Galle Fort Hotel')
  await page.getByTestId('project-create').click()
  await page.getByTestId('composer').fill('Write a long specification')
  await page.getByTestId('chat-send').click()
  await expect(page.getByTestId('live')).toContainText('word3')
  await page.getByTestId('chat-stop').click()
  const reply = page.getByTestId('msg-assistant')
  await expect(reply).toContainText('Stopped before the end.')
  await expect(reply).not.toContainText('word199')
  await expect(page.getByTestId('chat-send')).toBeVisible()
  await app.close()
  await ollama.close()
})

test('a stopped Ollama is explained in plain language', async () => {
  const app = await launchApp({ seed: { firstRunComplete: true, endpoints: { ollama: 'http://127.0.0.1:9', comfy: 'http://127.0.0.1:9' } } })
  const page = await app.firstWindow()
  await page.getByTestId('project-name').fill('Negombo Villa')
  await page.getByTestId('project-create').click()
  await expect(page.getByRole('alert').filter({ hasText: "Ollama isn't running" }).first()).toBeVisible()
  await page.getByTestId('composer').fill('Hello')
  await page.getByTestId('chat-send').click()
  await expect(page.getByTestId('chat-error')).toHaveText("Ollama isn't running. Start it from the Start menu, then try again.")
  await app.close()
})
