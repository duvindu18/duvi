import { deflateSync, crc32 } from 'node:zlib'
import { WebSocketServer, type WebSocket } from 'ws'
import { json, startFake, type FakeServer } from './http-fake'

/** A real (tiny, grey) PNG, with a ComfyUI-style "prompt" text chunk. */
export function makePng(width: number, height: number, text: Record<string, string> = {}): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)])
  const raw = Buffer.concat(Array.from({ length: height }, () => row))
  const texts = Object.entries(text).map(([k, v]) => chunk('tEXt', Buffer.concat([Buffer.from(k, 'latin1'), Buffer.from([0]), Buffer.from(v, 'latin1')])))
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...texts, chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

export interface FakeComfyOptions {
  port?: number
  checkpoints?: string[]
  controlnets?: string[]
  unets?: string[]
  clips?: string[]
  vaes?: string[]
  /** Sampling steps reported over the websocket. */
  steps?: number
  stepDelayMs?: number
  /** Make /prompt fail validation like a missing model. */
  rejectWith?: Record<string, unknown>
  /** Fail during execution. */
  failAtRun?: string
  /** Don't accept websockets (forces the app to poll /history). */
  noWebsocket?: boolean
}

export interface FakeComfy extends FakeServer {
  prompts: { id: string; prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>; clientId: string }[]
  uploads: string[]
  interrupted: number
}

/** Behaves like the parts of ComfyUI's API the app uses, including the progress websocket. */
export async function startFakeComfy(opts: FakeComfyOptions = {}): Promise<FakeComfy> {
  const checkpoints = opts.checkpoints ?? ['sd_xl_base_1.0.safetensors', 'juggernautXL_v9.safetensors']
  const controlnets = opts.controlnets ?? ['controlnet-canny-sdxl-1.0.safetensors']
  const unets = opts.unets ?? ['flux1-canny-dev.safetensors', 'flux1-dev.safetensors']
  const clips = opts.clips ?? ['clip_l.safetensors', 't5xxl_fp8_e4m3fn.safetensors']
  const vaes = opts.vaes ?? ['ae.safetensors', 'sdxl_vae.safetensors']
  const history: Record<string, unknown> = {}
  const sockets = new Map<string, WebSocket>()
  const state = { prompts: [] as FakeComfy['prompts'], uploads: [] as string[], interrupted: 0 }
  let counter = 0
  const outputPng = makePng(64, 40, { prompt: '{"fake":true}' })

  const send = (clientId: string, msg: unknown) => {
    const ws = sockets.get(clientId)
    if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
  }

  const fake = await startFake(
    {
      'GET /system_stats': (_q, res) =>
        json(res, 200, {
          system: { os: 'nt', comfyui_version: '0.0.0-fake', python_version: '3.12' },
          devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 5080 : cudaMallocAsync', type: 'cuda', vram_total: 17_094_000_000, vram_free: 15_000_000_000 }]
        }),
      'GET /object_info/CheckpointLoaderSimple': (_q, res) => json(res, 200, { CheckpointLoaderSimple: { input: { required: { ckpt_name: [checkpoints] } } } }),
      'GET /object_info/UNETLoader': (_q, res) => json(res, 200, { UNETLoader: { input: { required: { unet_name: [unets], weight_dtype: [['default', 'fp8_e4m3fn']] } } } }),
      'GET /object_info/DualCLIPLoader': (_q, res) => json(res, 200, { DualCLIPLoader: { input: { required: { clip_name1: [clips], clip_name2: [clips], type: [['sdxl', 'flux']] } } } }),
      'GET /object_info/VAELoader': (_q, res) => json(res, 200, { VAELoader: { input: { required: { vae_name: [vaes] } } } }),
      'GET /object_info/ControlNetLoader': (_q, res) => json(res, 200, { ControlNetLoader: { input: { required: { control_net_name: [controlnets] } } } }),
      'POST /upload/image': (_q, res, body) => {
        const name = /filename="([^"]+)"/.exec(body)?.[1] ?? 'upload.png'
        state.uploads.push(name)
        json(res, 200, { name, subfolder: '', type: 'input' })
      },
      'POST /prompt': (_q, res, body) => {
        if (opts.rejectWith) return json(res, 400, opts.rejectWith)
        const req = JSON.parse(body) as { prompt: FakeComfy['prompts'][number]['prompt']; client_id: string }
        const id = `fake-${++counter}`
        state.prompts.push({ id, prompt: req.prompt, clientId: req.client_id })
        json(res, 200, { prompt_id: id, number: counter, node_errors: {} })
        void (async () => {
          const steps = opts.steps ?? 4
          const interruptsBefore = state.interrupted // an earlier Stop must not stop this job
          send(req.client_id, { type: 'execution_start', data: { prompt_id: id } })
          send(req.client_id, { type: 'executing', data: { node: '4', prompt_id: id } })
          for (let i = 1; i <= steps; i++) {
            await new Promise((r) => setTimeout(r, opts.stepDelayMs ?? 10))
            if (state.interrupted > interruptsBefore) {
              send(req.client_id, { type: 'execution_interrupted', data: { prompt_id: id } })
              return
            }
            send(req.client_id, { type: 'progress', data: { value: i, max: steps, prompt_id: id, node: '3' } })
          }
          if (opts.failAtRun) {
            history[id] = { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: opts.failAtRun }]] } }
            send(req.client_id, { type: 'execution_error', data: { prompt_id: id, node_type: 'KSampler', exception_message: opts.failAtRun } })
            return
          }
          const saveNode = Object.entries(req.prompt).find(([, n]) => n.class_type === 'SaveImage')?.[0] ?? '9'
          history[id] = {
            outputs: { [saveNode]: { images: [{ filename: `ArchAI_${String(counter).padStart(5, '0')}_.png`, subfolder: 'ArchAI', type: 'output' }] } },
            status: { status_str: 'success', completed: true, messages: [] }
          }
          send(req.client_id, { type: 'executed', data: { node: saveNode, prompt_id: id } })
          send(req.client_id, { type: 'executing', data: { node: null, prompt_id: id } })
        })()
      },
      'GET /history/*': (q, res) => {
        const id = decodeURIComponent((q.url ?? '').split('/history/')[1] ?? '')
        json(res, 200, history[id] ? { [id]: history[id] } : {})
      },
      'GET /view': (_q, res) => {
        res.writeHead(200, { 'content-type': 'image/png' }).end(outputPng)
      },
      'POST /interrupt': (_q, res) => {
        state.interrupted++
        json(res, 200, {})
      },
      'POST /queue': (_q, res) => json(res, 200, {}),
      'POST /free': (_q, res) => json(res, 200, {})
    },
    opts.port
  )

  const wss = new WebSocketServer({ noServer: true })
  fake.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (opts.noWebsocket || url.pathname !== '/ws') return socket.destroy()
    wss.handleUpgrade(req, socket, head, (ws) => {
      const clientId = url.searchParams.get('clientId') ?? ''
      sockets.set(clientId, ws)
      ws.send(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: 0 } }, sid: clientId } }))
    })
  })

  const close = fake.close
  const out = Object.assign(fake, {
    prompts: state.prompts,
    uploads: state.uploads,
    close: async () => {
      for (const ws of sockets.values()) ws.terminate()
      wss.close()
      await close()
    }
  }) as FakeComfy
  Object.defineProperty(out, 'interrupted', { get: () => state.interrupted })
  return out
}
