import { describe, expect, it } from 'vitest'
import { INVOKE_CHANNELS, isEventChannel, isInvokeChannel } from '@shared/channels'
import { requestSchemas } from '@shared/ipc'

describe('IPC allow-list', () => {
  it('has a request schema for every channel and nothing extra', () => {
    expect(Object.keys(requestSchemas).sort()).toEqual([...INVOKE_CHANNELS].sort())
  })
  it('rejects unknown and non-string channel names', () => {
    expect(isInvokeChannel('app:info')).toBe(true)
    expect(isInvokeChannel('fs:readFile')).toBe(false)
    expect(isInvokeChannel({ toString: () => 'app:info' })).toBe(false)
    expect(isEventChannel('anything')).toBe(false)
  })
  it('validates payloads', () => {
    expect(requestSchemas['net:probe'].safeParse({ url: 'x'.repeat(3000) }).success).toBe(false)
    expect(requestSchemas['net:probe'].safeParse({ url: 'http://127.0.0.1:1' }).success).toBe(true)
    expect(requestSchemas['app:info'].safeParse({ sneaky: true }).success).toBe(false)
  })
})
