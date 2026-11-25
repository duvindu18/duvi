/**
 * Starts and stops a ComfyUI that ArchAI Studio installed (the Windows portable
 * build). ComfyUIs you installed yourself are never started or stopped by the app.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, existsSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../log'

export function portablePython(dir: string): string {
  return join(dir, 'python_embeded', process.platform === 'win32' ? 'python.exe' : 'python')
}

export function isPortableComfy(dir: string): boolean {
  return existsSync(portablePython(dir)) && existsSync(join(dir, 'ComfyUI', 'main.py'))
}

export class ComfyProcess {
  private child: ChildProcess | null = null

  constructor(private readonly logFile: string) {}

  running(): boolean {
    return this.child !== null && this.child.exitCode === null
  }

  start(dir: string, port: number): void {
    if (this.running()) return
    if (!isPortableComfy(dir)) throw new Error(`ComfyUI isn't installed in ${dir}.`)
    const out = createWriteStream(this.logFile, { flags: 'a' })
    // Listen on this computer only, never the network.
    this.child = spawn(portablePython(dir), ['-s', join('ComfyUI', 'main.py'), '--windows-standalone-build', '--listen', '127.0.0.1', '--port', String(port)], {
      cwd: dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child.stdout?.pipe(out)
    this.child.stderr?.pipe(out)
    this.child.on('exit', (code) => {
      log.info(`ComfyUI stopped (code ${code})`)
      this.child = null
    })
    log.info(`ComfyUI started from ${dir}`)
  }

  stop(): void {
    if (!this.child) return
    this.child.kill()
    this.child = null
  }
}
