/**
 * The IPC allow-list. The preload exposes ONLY these channel names to the
 * screen, and the main process registers handlers ONLY for these names.
 * Kept free of imports so the sandboxed preload can bundle it.
 *
 * Milestones add channels here (see PLAN.md section 6).
 */
export const INVOKE_CHANNELS = [
  'app:info',
  'net:probe',
  'settings:get',
  'settings:set',
  'settings:export',
  'settings:import',
  'dialog:pickFolder',
  'projects:list',
  'projects:create',
  'projects:rename',
  'projects:archive',
  'checks:run',
  'services:ping',
  'disk:free',
  'clipboard:writeText',
  'chat:models',
  'chat:threads',
  'chat:history',
  'chat:send',
  'chat:cancel',
  'chat:renameThread',
  'gpu:get',
  'scripts:generate',
  'scripts:explain',
  'scripts:fix',
  'scripts:save',
  'scripts:list',
  'images:workflows',
  'images:importWorkflow',
  'images:saveWorkflow',
  'images:models',
  'images:promptHelp',
  'images:pickInput',
  'images:generate',
  'images:cancel',
  'gallery:list',
  'gallery:reveal',
  'gallery:trash',
  'setup:components',
  'setup:plan',
  'setup:download',
  'setup:cancel',
  'setup:pickComfyFolder',
  'comfy:start',
  'comfy:stop'
] as const

export const EVENT_CHANNELS = ['chat:chunk', 'chat:done', 'chat:error', 'gpu:state', 'images:progress', 'images:done', 'images:error', 'setup:progress', 'setup:done'] as const

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number]
export type EventChannel = (typeof EVENT_CHANNELS)[number]

export function isInvokeChannel(name: unknown): name is InvokeChannel {
  return typeof name === 'string' && (INVOKE_CHANNELS as readonly string[]).includes(name)
}

export function isEventChannel(name: unknown): name is EventChannel {
  return typeof name === 'string' && (EVENT_CHANNELS as readonly string[]).includes(name)
}
