// DXF parsing off the UI thread so large drawings never freeze pan/zoom.
import { parseDxf } from './cad/dxf';

self.onmessage = (e: MessageEvent<{ id: number; text: string }>) => {
  try {
    (self as any).postMessage({ id: e.data.id, ok: true, drawing: parseDxf(e.data.text) });
  } catch (err: any) {
    (self as any).postMessage({ id: e.data.id, ok: false, error: String(err?.message ?? err) });
  }
};
