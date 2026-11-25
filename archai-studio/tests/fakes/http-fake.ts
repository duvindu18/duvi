import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Route = (req: IncomingMessage, res: ServerResponse, body: string) => unknown

export interface FakeServer {
  url: string
  port: number
  server: Server
  requests: { method: string; path: string; body: string }[]
  close(): Promise<void>
}

/** Minimal HTTP fake bound to 127.0.0.1 on a random (or given) port. */
export async function startFake(routes: Record<string, Route>, port = 0): Promise<FakeServer> {
  const requests: FakeServer['requests'] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString('latin1')))
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/'
      requests.push({ method: req.method ?? 'GET', path, body })
      // Exact route first, then a "prefix/*" route.
      const route =
        routes[`${req.method} ${path}`] ??
        Object.entries(routes).find(([k]) => k.endsWith('/*') && `${req.method} ${path}`.startsWith(k.slice(0, -1)))?.[1]
      if (!route) {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}')
        return
      }
      void Promise.resolve(route(req, res, body)).catch(() => res.writeHead(500).end())
    })
  })
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
  const actual = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${actual}`,
    port: actual,
    server,
    requests,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) })
  }
}

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data))
}
