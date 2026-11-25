import { createHash } from 'node:crypto'
import { startFake, type FakeServer } from './http-fake'

export interface FakeFile {
  bytes: Buffer
  /** Pretend the publisher's checksum is this (to test mismatches). */
  publishedSha?: string
  gated?: boolean
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/**
 * Stands in for GitHub releases and Hugging Face: release JSON with digests,
 * asset downloads with Range support, and HF resolve HEADs with x-linked-* headers.
 */
export async function startFakeInternet(opts: { github: Record<string, Record<string, FakeFile>>; hf: Record<string, Record<string, FakeFile>>; dropAfterBytes?: number }) {
  const served: { path: string; range: string | null }[] = []
  let dropOnce = opts.dropAfterBytes
  const fake: FakeServer = await startFake({
    'GET /repos/*': (req, res) => {
      const m = /^\/repos\/([^/]+\/[^/]+)\/releases\/latest$/.exec(req.url ?? '')
      const assets = m ? opts.github[m[1]!] : undefined
      if (!assets) return res.writeHead(404).end('{}')
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          tag_name: 'v1.0.0',
          assets: Object.entries(assets).map(([name, f]) => ({
            name,
            size: f.bytes.length,
            digest: name.endsWith('.txt') ? null : `sha256:${f.publishedSha ?? sha(f.bytes)}`,
            browser_download_url: `${fake.url}/dl/${m![1]}/${name}`
          }))
        })
      )
    },
    'GET /dl/*': (req, res) => {
      const [, , owner, repo, name] = (req.url ?? '').split('/')
      const f = opts.github[`${owner}/${repo}`]?.[decodeURIComponent(name ?? '')]
      if (!f) return res.writeHead(404).end()
      serve(req.url ?? '', f.bytes, req.headers.range ?? null, res)
    },
    'HEAD /*': (req, res) => {
      const m = /^\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/.exec(req.url ?? '')
      const f = m ? opts.hf[m[1]!]?.[m[2]!] : undefined
      if (!f) return res.writeHead(404).end()
      if (f.gated) return res.writeHead(401).end()
      res.writeHead(302, { location: `${fake.url}/cdn/${m![1]}/${m![2]}`, 'x-linked-size': String(f.bytes.length), 'x-linked-etag': `"${f.publishedSha ?? sha(f.bytes)}"` }).end()
    },
    'GET /cdn/*': (req, res) => {
      const m = /^\/cdn\/([^/]+\/[^/]+)\/(.+)$/.exec(req.url ?? '')
      const f = m ? opts.hf[m[1]!]?.[m[2]!] : undefined
      if (!f) return res.writeHead(404).end()
      serve(req.url ?? '', f.bytes, req.headers.range ?? null, res)
    },
    'GET /*': (req, res) => {
      // HF resolve with GET follows to the CDN.
      const m = /^\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/.exec(req.url ?? '')
      if (!m) return res.writeHead(404).end()
      res.writeHead(302, { location: `${fake.url}/cdn/${m[1]}/${m[2]}` }).end()
    }
  })

  function serve(path: string, bytes: Buffer, range: string | null, res: import('node:http').ServerResponse) {
    served.push({ path, range })
    let start = 0
    if (range) {
      start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0)
      if (start >= bytes.length) return res.writeHead(416).end()
      res.writeHead(206, { 'content-length': String(bytes.length - start), 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` })
    } else res.writeHead(200, { 'content-length': String(bytes.length) })
    const body = bytes.subarray(start)
    if (dropOnce !== undefined && !range) {
      // Simulate a dropped connection part-way.
      const cut = dropOnce
      dropOnce = undefined
      res.write(body.subarray(0, cut))
      setTimeout(() => res.destroy(), 20)
      return
    }
    res.end(body)
  }

  return Object.assign(fake, { served })
}
