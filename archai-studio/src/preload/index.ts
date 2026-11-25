/**
 * The bridge between the locked-down screen and the main process.
 * Exposes exactly two functions; both refuse any channel not on the allow-list.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { isEventChannel, isInvokeChannel } from '@shared/channels'
import type { ArchaiApi } from './api'

const api: ArchaiApi = {
  invoke: (channel, req) => {
    if (!isInvokeChannel(channel)) return Promise.reject(new Error(`Channel not allowed: ${String(channel)}`))
    return ipcRenderer.invoke(channel, req)
  },
  on: (channel, listener) => {
    if (!isEventChannel(channel)) throw new Error(`Event not allowed: ${String(channel)}`)
    const wrapped = (_e: Electron.IpcRendererEvent, payload: unknown) => listener(payload as never)
    ipcRenderer.on(channel, wrapped)
    return () => ipcRenderer.removeListener(channel, wrapped)
  }
}

contextBridge.exposeInMainWorld('archai', Object.freeze(api))
