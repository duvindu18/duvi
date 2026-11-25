import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchApp, makeDirs as dirs, type Dirs } from './launch'

async function open(d: Dirs, first = true): Promise<[ElectronApplication, Page]> {
  // Seed settings only on the first launch; later launches must read what the app saved.
  const app = await launchApp({ dirs: d, seed: first ? { firstRunComplete: true } : null })
  const page = await app.firstWindow()
  await expect(page.getByTestId('titleblock')).toBeVisible()
  return [app, page]
}

async function createProject(page: Page, name: string) {
  await page.getByTestId('project-name').fill(name)
  await page.getByTestId('project-create').click()
}

test('first launch asks for a project, then remembers everything after restart', async () => {
  const d = dirs()
  let [app, page] = await open(d)

  await expect(page.getByTestId('start-project')).toBeVisible()
  await expect(page.getByTestId('tb-project')).toHaveText('None')

  // Empty and duplicate names are explained.
  await page.getByTestId('project-create').click()
  await expect(page.getByRole('alert')).toHaveText('Give the project a name.')
  await createProject(page, 'Kandy Residence')
  await expect(page.getByTestId('tb-project')).toHaveText('Kandy Residence')
  await expect(page.getByTestId('chat')).toBeVisible()

  // Second project through the switcher.
  await page.getByTestId('project-switcher').click()
  await page.getByRole('button', { name: 'New project…' }).click()
  await page.getByRole('dialog').getByTestId('project-name').fill('kandy residence')
  await page.getByRole('dialog').getByTestId('project-create').click()
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('already exists')
  await page.getByRole('dialog').getByTestId('project-name').fill('Galle Fort Hotel')
  await page.getByRole('dialog').getByTestId('project-create').click()
  await expect(page.getByRole('dialog')).toBeHidden()
  await expect(page.getByTestId('tb-project')).toHaveText('Galle Fort Hotel')

  // Switch back.
  await page.getByTestId('project-switcher').click()
  await page.getByRole('option', { name: 'Kandy Residence' }).click()
  await expect(page.getByTestId('tb-project')).toHaveText('Kandy Residence')

  // Theme.
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('theme-phthalo').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'phthalo')
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(18, 53, 36)')
  await page.getByTestId('theme-light').click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')

  await app.close()
  ;[app, page] = await open(d, false)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.getByTestId('tb-project')).toHaveText('Kandy Residence')
  await app.close()
})

test('settings validate input in plain language', async () => {
  const [app, page] = await open(dirs())
  await page.getByTestId('nav-settings').click()

  const ollama = page.getByTestId('set-ollama')
  await ollama.fill('http://192.168.1.10:11434')
  await ollama.press('Enter')
  await expect(page.getByRole('alert').first()).toContainText('on this computer')

  await ollama.fill('http://127.0.0.1:11500/')
  await ollama.press('Enter')
  await expect(page.getByTestId('toast')).toHaveText('Settings saved')
  await expect(ollama).toHaveValue('http://127.0.0.1:11500')
  // The network guard picks up the new port at once.
  const probe = await page.evaluate(() => window.archai.invoke('net:probe', { url: 'http://127.0.0.1:11500/api/tags' }))
  expect(probe.ok && probe.data.allowed).toBe(true)

  const ctx = page.getByTestId('set-context')
  await ctx.fill('32768')
  await expect(page.getByText('may not fit in your 16 GB')).toBeVisible()
  await ctx.fill('abc')
  await ctx.press('Enter')
  await expect(page.getByText('Enter a whole number.')).toBeVisible()
  await app.close()
})

test('projects can be renamed and archived without deleting', async () => {
  const [app, page] = await open(dirs())
  await createProject(page, 'Negombo Villa')
  await page.getByTestId('nav-settings').click()
  const list = page.getByTestId('project-list')
  await list.getByRole('button', { name: 'Rename' }).click()
  await page.getByTestId('rename-input').fill('Negombo Beach Villa')
  await page.getByTestId('rename-input').press('Enter')
  await expect(list).toContainText('Negombo Beach Villa')
  await expect(page.getByTestId('tb-project')).toHaveText('Negombo Beach Villa')

  await list.getByRole('button', { name: 'Archive' }).click()
  await expect(page.getByTestId('tb-project')).toHaveText('None')
  await expect(list).toContainText('No projects yet.')
  await page.getByText('Show archived projects').click()
  await expect(list).toContainText('Negombo Beach Villa (archived)')
  await list.getByRole('button', { name: 'Restore' }).click()
  await expect(list).not.toContainText('(archived)')
  await app.close()
})

test('settings export and import round-trip, keeping this PC folders', async () => {
  const d = dirs()
  const [app, page] = await open(d)
  const file = join(d.root, 'exported.json')
  await app.evaluate(({ dialog }, f) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: f })) as typeof dialog.showSaveDialog
  }, file)
  await page.getByTestId('nav-settings').click()
  await page.getByTestId('settings-export').click()
  await expect(page.getByTestId('toast')).toContainText('exported')
  const exported = JSON.parse(readFileSync(file, 'utf8'))
  expect(exported.models.chat).toBe('gpt-oss:20b')
  expect(exported.activeProjectId).toBeUndefined()

  const incoming = join(d.root, 'incoming.json')
  writeFileSync(incoming, JSON.stringify({ ...exported, theme: 'light', models: { chat: 'qwen3:14b' }, folders: { data: 'Z:\\elsewhere' } }))
  await app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as typeof dialog.showOpenDialog
  }, incoming)
  await page.getByTestId('settings-import').click()
  await expect(page.getByTestId('toast')).toContainText('imported')
  await expect(page.getByTestId('set-model-chat')).toHaveValue('qwen3:14b')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect(page.getByTestId('data-folder')).toHaveText(d.data)

  // A broken file is explained, not a crash.
  writeFileSync(incoming, '{ nope')
  await page.getByTestId('settings-import').click()
  await expect(page.getByTestId('toast')).toContainText('not valid JSON')
  await app.close()
})
