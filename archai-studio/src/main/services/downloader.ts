/**
 * Resumable, verified file downloads. A file is written to "<name>.part" and only
 * renamed to its real name after its size and SHA-256 checksum match.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export class DownloadError extends Error {}

export interface DownloadOptions {
  url: string
  dest: string
  fetch: FetchLike
  expectedSize?: number
  /** Lower-case hex. */
  expectedSha256?: string
  signal?: AbortSignal
  onProgress?: (bytes: number, total: number) => void
}

async function hashFile(path: string, hash: ReturnType<typeof createHash>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (c) => hash.update(c))
      .on('end', () => resolve())
      .on('error', reject)
  })
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256')
  await hashFile(path, h)
  return h.digest('hex')
}

export async function downloadFile(o: DownloadOptions): Promise<void> {
  mkdirSync(dirname(o.dest), { recursive: true })
  if (existsSync(o.dest)) throw new DownloadError(`A file called ${o.dest.split(/[\\/]/).pop()} is already there, so it was left as it is.`)
  const part = `${o.dest}.part`
  let have = existsSync(part) ? statSync(part).size : 0
  if (o.expectedSize !== undefined && have > o.expectedSize) {
    unlinkSync(part)
    have = 0
  }
  const hash = createHash('sha256')

  let res: Response | null = null
  if (have > 0 && !(o.expectedSize !== undefined && have === o.expectedSize)) {
    res = await o.fetch(o.url, { headers: { Range: `bytes=${have}-` }, signal: o.signal })
    if (res.status === 206) {
      await hashFile(part, hash)
    } else if (res.status === 200) {
      have = 0 // server ignored the range: start again
    } else if (res.status === 416) {
      res = null // already complete
      await hashFile(part, hash)
    } else {
      throw new DownloadError(`The download server replied ${res.status}.`)
    }
  } else if (have > 0) {
    await hashFile(part, hash) // complete .part from an earlier run
  } else {
    res = await o.fetch(o.url, { signal: o.signal })
    if (!res.ok) throw new DownloadError(`The download server replied ${res.status}.`)
  }

  if (res) {
    const lenHeader = Number(res.headers.get('content-length') ?? NaN)
    const total = o.expectedSize ?? (Number.isFinite(lenHeader) ? have + lenHeader : 0)
    if (!res.body) throw new DownloadError('The download server sent no data.')
    const out = createWriteStream(part, { flags: have > 0 && res.status === 206 ? 'a' : 'w' })
    let bytes = have
    let lastReport = 0
    try {
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        hash.update(value)
        bytes += value.length
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()))
        const now = Date.now()
        if (now - lastReport > 250) {
          lastReport = now
          o.onProgress?.(bytes, total)
        }
      }
    } finally {
      await new Promise<void>((r) => out.end(() => r()))
    }
    o.onProgress?.(bytes, total || bytes)
  }

  const size = statSync(part).size
  if (o.expectedSize !== undefined && size !== o.expectedSize) {
    if (size > o.expectedSize) unlinkSync(part)
    throw new DownloadError(`The download is incomplete (${size} of ${o.expectedSize} bytes). Try again to resume it.`)
  }
  const digest = hash.digest('hex')
  if (o.expectedSha256 && digest !== o.expectedSha256.toLowerCase()) {
    unlinkSync(part) // our own temporary file, known to be wrong
    throw new DownloadError('The downloaded file failed its checksum, so it was discarded. Try again.')
  }
  // Never replace an existing file of yours.
  if (existsSync(o.dest)) throw new DownloadError(`A file called ${o.dest.split(/[\\/]/).pop()} is already there, so it was left as it is.`)
  renameSync(part, o.dest)
}
