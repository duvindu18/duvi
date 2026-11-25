/** Splits a byte stream into JSON objects, one per line (Ollama's streaming format). */
export async function* readNdjson<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line) yield JSON.parse(line) as T
      }
    }
    buf += decoder.decode()
    if (buf.trim()) yield JSON.parse(buf.trim()) as T
  } finally {
    reader.releaseLock()
  }
}
