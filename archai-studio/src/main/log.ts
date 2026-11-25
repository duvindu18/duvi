/** Local-only logging (console for now; a rotating file log arrives in M1). Nothing is ever sent anywhere. */
export const log = {
  info: (msg: string) => console.log(`[archai] ${msg}`),
  warn: (msg: string) => console.warn(`[archai] ${msg}`),
  error: (msg: string, err?: unknown) => console.error(`[archai] ${msg}`, err instanceof Error ? err.message : (err ?? ''))
}
