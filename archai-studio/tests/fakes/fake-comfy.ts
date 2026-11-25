import { json, startFake, type FakeServer } from './http-fake'

/** Behaves like the parts of ComfyUI's HTTP API used by the wizard. Websocket arrives in M5. */
export function startFakeComfy(opts: { port?: number } = {}): Promise<FakeServer> {
  let counter = 0
  return startFake(
    {
      'GET /system_stats': (_q, res) =>
        json(res, 200, {
          system: { os: 'nt', comfyui_version: '0.0.0-fake', python_version: '3.12' },
          devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 5080 : cudaMallocAsync', type: 'cuda', vram_total: 17_094_000_000, vram_free: 15_000_000_000 }]
        }),
      'POST /prompt': (_q, res) => json(res, 200, { prompt_id: `fake-${++counter}`, number: counter, node_errors: {} }),
      'POST /free': (_q, res) => json(res, 200, {})
    },
    opts.port
  )
}
