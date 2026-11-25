import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultSettings, loopbackPorts } from '@shared/settings'
import { mergeLenient, SettingsStore } from '../../src/main/settings-store'

const tmp = () => mkdtempSync(join(tmpdir(), 'archai-settings-'))

describe('settings', () => {
  it('starts with sensible defaults', () => {
    const s = new SettingsStore(join(tmp(), 'settings.json'), 'C:\\Users\\me\\ArchAI Studio').get()
    expect(s.theme).toBe('dark')
    expect(s.models.chat).toBe('gpt-oss:20b')
    expect(s.chat.contextLength).toBe(8192)
    expect(s.folders.data).toBe('C:\\Users\\me\\ArchAI Studio')
    expect(s.firstRunComplete).toBe(false)
  })

  it('saves and reloads', () => {
    const file = join(tmp(), 'settings.json')
    new SettingsStore(file, '/d').set({ theme: 'light', models: { chat: 'qwen3:14b' } })
    const again = new SettingsStore(file, '/d').get()
    expect(again.theme).toBe('light')
    expect(again.models).toEqual({ chat: 'qwen3:14b', scripts: 'gpt-oss:20b', embed: 'nomic-embed-text' })
  })

  it('accepts only local service addresses', () => {
    const st = new SettingsStore(join(tmp(), 's.json'), '/d')
    expect(st.set({ endpoints: { ollama: 'http://localhost:11500/' } }).endpoints.ollama).toBe('http://localhost:11500')
    expect(() => st.set({ endpoints: { ollama: 'http://192.168.1.5:11434' } })).toThrow()
    expect(() => st.set({ endpoints: { comfy: 'https://comfy.example.com' } })).toThrow()
    expect(() => st.set({ unknownKey: 1 } as never)).toThrow()
    expect(() => st.set({ chat: { contextLength: 100 } })).toThrow()
  })

  it('updates network guard ports from endpoints', () => {
    const s = defaultSettings('/d')
    expect(loopbackPorts(s).sort()).toEqual([11434, 8188].sort())
  })

  it('survives a corrupted or partly invalid settings file', () => {
    const dir = tmp()
    const file = join(dir, 'settings.json')
    writeFileSync(file, '{ not json')
    expect(new SettingsStore(file, '/d').get().theme).toBe('dark')
    writeFileSync(file, JSON.stringify({ theme: 'light', endpoints: { ollama: 'http://evil.com' }, chat: { contextLength: 4096 } }))
    const s = new SettingsStore(file, '/d').get()
    expect(s.theme).toBe('light')
    expect(s.chat.contextLength).toBe(4096)
    expect(s.endpoints.ollama).toBe('http://127.0.0.1:11434')
  })

  it('import keeps this PC folders and ignores bad sections', () => {
    const st = new SettingsStore(join(tmp(), 's.json'), '/mine')
    const s = st.importFrom({ theme: 'light', folders: { data: '/someone-else' }, models: { chat: '' } }, true)
    expect(s.theme).toBe('light')
    expect(s.folders.data).toBe('/mine')
    expect(s.models.chat).toBe('gpt-oss:20b')
  })

  it('writes the file atomically as readable JSON', () => {
    const file = join(tmp(), 's.json')
    new SettingsStore(file, '/d').set({ theme: 'system' })
    expect(JSON.parse(readFileSync(file, 'utf8')).theme).toBe('system')
  })

  it('mergeLenient ignores non-objects', () => {
    const base = defaultSettings('/d')
    expect(mergeLenient(base, null)).toEqual(base)
    expect(mergeLenient(base, 'x')).toEqual(base)
  })
})
