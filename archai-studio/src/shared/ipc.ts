/**
 * Typed IPC contract: for every channel, the request schema (checked in the
 * main process before any handler runs) and the response type.
 */
import { z } from 'zod'
import type { InvokeChannel } from './channels'
import type { Project } from './projects'
import { ProjectName } from './projects'
import type { Settings, SettingsPatch } from './settings'
import { SettingsPatchSchema } from './settings'

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  buildType: z.enum(['dev', 'exe', 'store']),
  platform: z.string(),
  electron: z.string(),
  userData: z.string()
})
export type AppInfo = z.infer<typeof AppInfoSchema>

export interface NetProbeResult {
  url: string
  allowed: boolean
  reason: string
}

/** Result of a user-cancellable file operation. */
export type FileOpResult = { done: true; path: string } | { done: false }

const Id = z.number().int().positive()

export const requestSchemas = {
  'app:info': z.undefined(),
  /** Asks the network guard whether a URL would be allowed. Never fetches. */
  'net:probe': z.object({ url: z.string().max(2048) }).strict(),
  'settings:get': z.undefined(),
  'settings:set': SettingsPatchSchema,
  'settings:export': z.undefined(),
  'settings:import': z.undefined(),
  'dialog:pickFolder': z.object({ title: z.string().max(200), defaultPath: z.string().max(1000).optional() }).strict(),
  'projects:list': z.object({ includeArchived: z.boolean() }).strict().optional(),
  'projects:create': z.object({ name: ProjectName }).strict(),
  'projects:rename': z.object({ id: Id, name: ProjectName }).strict(),
  'projects:archive': z.object({ id: Id, archived: z.boolean() }).strict()
} satisfies Record<InvokeChannel, z.ZodType>

export interface InvokeMap {
  'app:info': { req: undefined; res: AppInfo }
  'net:probe': { req: { url: string }; res: NetProbeResult }
  'settings:get': { req: undefined; res: Settings }
  'settings:set': { req: SettingsPatch; res: Settings }
  'settings:export': { req: undefined; res: FileOpResult }
  'settings:import': { req: undefined; res: FileOpResult & { settings?: Settings } }
  'dialog:pickFolder': { req: { title: string; defaultPath?: string }; res: FileOpResult }
  'projects:list': { req: { includeArchived: boolean } | undefined; res: Project[] }
  'projects:create': { req: { name: string }; res: Project }
  'projects:rename': { req: { id: number; name: string }; res: Project }
  'projects:archive': { req: { id: number; archived: boolean }; res: Project }
}

// Compile-time check that InvokeMap and the channel list stay in sync.
type _MissingInMap = Exclude<InvokeChannel, keyof InvokeMap>
type _ExtraInMap = Exclude<keyof InvokeMap, InvokeChannel>
const _sync: [_MissingInMap, _ExtraInMap] extends [never, never] ? true : never = true
void _sync

export type EventMap = Record<never, never>

/** Error shape returned across IPC (never a raw stack trace). */
export interface IpcError {
  code: 'INVALID_REQUEST' | 'NOT_ALLOWED' | 'NOT_FOUND' | 'INTERNAL'
  message: string
}
