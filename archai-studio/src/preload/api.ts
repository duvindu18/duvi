import type { EventChannel, InvokeChannel } from '@shared/channels'
import type { EventMap, InvokeMap, IpcError } from '@shared/ipc'

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }

export interface ArchaiApi {
  invoke<K extends InvokeChannel>(channel: K, req?: InvokeMap[K]['req']): Promise<IpcResult<InvokeMap[K]['res']>>
  on<K extends EventChannel>(channel: K, listener: (payload: K extends keyof EventMap ? EventMap[K] : never) => void): () => void
}
