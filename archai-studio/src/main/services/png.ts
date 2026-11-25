/**
 * Minimal PNG helpers: read the size, read text chunks, and add text chunks
 * (prompt, seed, model) without re-encoding the image.
 */
import { crc32 } from 'node:zlib'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function isPng(b: Buffer): boolean {
  return b.length > 33 && b.subarray(0, 8).equals(SIG)
}

export function pngSize(b: Buffer): { width: number; height: number } | null {
  if (!isPng(b) || b.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td) >>> 0)
  return Buffer.concat([len, td, crc])
}

/** iTXt (UTF-8) text chunk, so m², ° and Sinhala text survive. */
function itxt(key: string, value: string): Buffer {
  return chunk('iTXt', Buffer.concat([Buffer.from(key, 'latin1'), Buffer.from([0, 0, 0, 0, 0]), Buffer.from(value, 'utf8')]))
}

/** Inserts text chunks just before IEND. Existing chunks (including ComfyUI's own) are kept. */
export function addPngText(b: Buffer, entries: Record<string, string>): Buffer {
  if (!isPng(b)) throw new Error('Not a PNG image.')
  const iend = b.lastIndexOf(Buffer.from('IEND', 'ascii')) - 4
  if (iend < 8) throw new Error('Damaged PNG image.')
  const extra = Object.entries(entries).map(([k, v]) => itxt(k, v))
  return Buffer.concat([b.subarray(0, iend), ...extra, b.subarray(iend)])
}

/** Reads tEXt and iTXt chunks (for tests and for showing metadata). */
export function readPngText(b: Buffer): Record<string, string> {
  const out: Record<string, string> = {}
  if (!isPng(b)) return out
  let p = 8
  while (p + 12 <= b.length) {
    const len = b.readUInt32BE(p)
    const type = b.toString('ascii', p + 4, p + 8)
    const data = b.subarray(p + 8, p + 8 + len)
    if (type === 'tEXt') {
      const z = data.indexOf(0)
      if (z > 0) out[data.toString('latin1', 0, z)] = data.toString('latin1', z + 1)
    } else if (type === 'iTXt') {
      const z = data.indexOf(0)
      if (z > 0) {
        // keyword\0 compressionFlag compressionMethod language\0 translated\0 text
        let q = z + 3
        q = data.indexOf(0, q) + 1
        q = data.indexOf(0, q) + 1
        out[data.toString('latin1', 0, z)] = data.toString('utf8', q)
      }
    }
    if (type === 'IEND') break
    p += 12 + len
  }
  return out
}
