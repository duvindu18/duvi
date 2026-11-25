/**
 * Typed IPC contract: for every channel, the request schema (checked in the
 * main process before any handler runs) and the response type.
 */
import { z } from 'zod'
import type { InvokeChannel } from './channels'

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  buildType: z.enum(['dev', 'exe', 'store']),
  platform: z.string(),
  electron: z.string(),
  userData: z.string()
})
export type AppInfo = z.infer<typeof AppInfoSchema>

export const NetProbeResultSchema = z.object({
  url: z.string(),
  allowed: z.boolean(),
  reason: z.string()
})
export type NetProbeResult = z.infer<typeof NetProbeResultSchema>

export const requestSchemas = {
  'app:info': z.undefined(),
  /** Asks the network guard whether a URL would be allowed. Never fetches. */
  'net:probe': z.object({ url: z.string().max(2048) })
} satisfies Record<InvokeChannel, z.ZodType>

export interface InvokeMap {
  'app:info': { req: undefined; res: AppInfo }
  'net:probe': { req: { url: string }; res: NetProbeResult }
}

// Compile-time check that InvokeMap and the channel list stay in sync.
type _MissingInMap = Exclude<InvokeChannel, keyof InvokeMap>
type _ExtraInMap = Exclude<keyof InvokeMap, InvokeChannel>
const _sync: [_MissingInMap, _ExtraInMap] extends [never, never] ? true : never = true
void _sync

export type EventMap = Record<never, never>

/** Error shape returned across IPC (never a raw stack trace). */
export interface IpcError {
  code: 'INVALID_REQUEST' | 'NOT_ALLOWED' | 'INTERNAL'
  message: string
}
