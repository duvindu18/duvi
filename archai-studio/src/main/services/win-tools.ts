/** Real (Windows) implementations behind the setup service. Tests replace these. */
import { execFile, spawn } from 'node:child_process'
import { accessSync, chmodSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { log } from '../log'

/** Windows' own Authenticode check. The path goes through an environment variable, never into the command text. */
export function verifySignature(file: string, publisher: string): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false)
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', '$s = Get-AuthenticodeSignature -LiteralPath $env:ARCHAI_FILE; "$($s.Status)|$($s.SignerCertificate.Subject)"'],
      { env: { ...process.env, ARCHAI_FILE: file }, timeout: 60_000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(false)
        const [status, subject] = stdout.trim().split('|')
        log.info(`signature of ${file}: ${status} ${subject ?? ''}`)
        resolve(status === 'Valid' && (subject ?? '').includes(publisher))
      }
    )
  })
}

export function runInstaller(file: string, args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(file, args, { windowsHide: false, stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', (code) => resolve(code ?? 1))
  })
}

/** The bundled 7-Zip (7zip-bin). In a packaged app it lives outside the asar archive. */
export function sevenZipPath(): string {
  const req = createRequire(import.meta.url)
  const p = (req('7zip-bin') as { path7za: string }).path7za
  if (process.platform !== 'win32') {
    // The npm package doesn't always keep the executable bit (Linux CI only; Windows uses 7za.exe).
    try {
      accessSync(p, constants.X_OK)
    } catch {
      chmodSync(p, 0o755)
    }
  }
  return p.replace(`app.asar${process.platform === 'win32' ? '\\' : '/'}`, `app.asar.unpacked${process.platform === 'win32' ? '\\' : '/'}`)
}

export function extract7z(archive: string, destDir: string, onPct: (pct: number) => void, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(sevenZipPath(), ['x', archive, `-o${destDir}`, '-y', '-bsp1', '-bso0'], { windowsHide: true })
    signal?.addEventListener('abort', () => p.kill())
    let err = ''
    p.stdout.on('data', (d: Buffer) => {
      const m = /(\d{1,3})%/.exec(d.toString())
      if (m) onPct(Number(m[1]))
    })
    p.stderr.on('data', (d: Buffer) => (err += d.toString()))
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking failed (7-Zip code ${code}). ${err.trim().slice(0, 200)}`))))
  })
}
