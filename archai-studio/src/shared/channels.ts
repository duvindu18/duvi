/**
 * The IPC allow-list. The preload exposes ONLY these channel names to the
 * screen, and the main process registers handlers ONLY for these names.
 * Kept free of imports so the sandboxed preload can bundle it.
 *
 * Milestones add channels here (see PLAN.md section 6).
 */
export const INVOKE_CHANNELS = ['app:info', 'net:probe'] as const

export const EVENT_CHANNELS = [] as const

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]
export type EventChannel = (typeof EVENT_CHANNELS)[number]

export function isInvokeChannel(name: unknown): name is InvokeChannel {
  return typeof name === 'string' && (INVOKE_CHANNELS as readonly string[]).includes(name)
}

export function isEventChannel(name: unknown): name is EventChannel {
  return typeof name === 'string' && (EVENT_CHANNELS as readonly string[]).includes(name)
}
