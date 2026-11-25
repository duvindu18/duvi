import type { InvokeChannel } from '@shared/channels'
import type { InvokeMap } from '@shared/ipc'

/** Calls the main process and throws a readable Error if it refused or failed. */
export async function call<K extends InvokeChannel>(channel: K, req?: InvokeMap[K]['req']): Promise<InvokeMap[K]['res']> {
  const r = await window.archai.invoke(channel, req)
  if (!r.ok) throw new Error(r.error.message)
  return r.data
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.'
}
