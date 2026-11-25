import type { ArchaiApi } from './api'

declare global {
  interface Window {
    readonly archai: ArchaiApi
  }
}
export {}
