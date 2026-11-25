/**
 * IPC router: registers one handler per allow-listed channel, validates the
 * request with zod, checks the sender is our own window, and never leaks
 * stack traces to the screen.
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { INVOKE_CHANNELS, type InvokeChannel } from '@shared/channels'
import { requestSchemas, type InvokeMap, type IpcError } from '@shared/ipc'
import { log } from './log'
import { isAppUrl } from './protocol'

export type Handlers = {
  [K in InvokeChannel]: (req: InvokeMap[K]['req'], event: IpcMainInvokeEvent) => Promise<InvokeMap[K]['res']> | InvokeMap[K]['res']
}

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }

export function isTrustedSender(senderUrl: string, devServerOrigin?: string): boolean {
  return isAppUrl(senderUrl, devServerOrigin)
}

export function registerIpc(handlers: Handlers, devServerOrigin?: string): void {
  for (const channel of INVOKE_CHANNELS) {
    ipcMain.handle(channel, async (event, raw: unknown): Promise<IpcResult<unknown>> => {
      const frameUrl = event.senderFrame?.url ?? ''
      if (!isTrustedSender(frameUrl, devServerOrigin)) {
        log.warn(`IPC ${channel} refused from untrusted sender`)
        return { ok: false, error: { code: 'NOT_ALLOWED', message: 'Untrusted sender' } }
      }
      const parsed = requestSchemas[channel].safeParse(raw)
      if (!parsed.success) {
        return { ok: false, error: { code: 'INVALID_REQUEST', message: parsed.error.issues.map((i) => i.message).join('; ') } }
      }
      try {
        const handler = handlers[channel] as (req: unknown, e: IpcMainInvokeEvent) => unknown
        return { ok: true, data: await handler(parsed.data, event) }
      } catch (err) {
        log.error(`IPC ${channel} failed`, err)
        return { ok: false, error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'Unexpected error' } }
      }
    })
  }
}
