// DWG → DXF conversion on the device, using acad-ts (MIT; TypeScript port of ACadSharp).
// Reads AutoCAD R12 through 2018+ (AC1009–AC1032). The DXF is then fed to our own streaming
// DXF engine, so DWG files get exactly the same rendering, snapping, search and compare.

export interface DwgResult { dxf: Uint8Array; version: string; notes: string[] }

/** Collects the writer's many small strings into ~1 MB UTF-8 blocks (encoding tiny strings one by one is slow). */
class Utf8Sink {
  private parts: string[] = [];
  private pending = 0;
  private enc = new TextEncoder();
  chunks: Uint8Array[] = [];
  size = 0;
  write(s: string | Uint8Array) {
    if (typeof s !== 'string') { this.flush(); this.chunks.push(s.slice()); this.size += s.length; return; }
    this.parts.push(s);
    this.pending += s.length;
    if (this.pending > 1 << 20) this.flush();
  }
  flush() {
    if (!this.parts.length) return;
    const b = this.enc.encode(this.parts.join(''));
    this.chunks.push(b);
    this.size += b.length;
    this.parts = [];
    this.pending = 0;
  }
  bytes(): Uint8Array {
    this.flush();
    const out = new Uint8Array(this.size);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    this.chunks = [];
    return out;
  }
}

export async function dwgToDxf(buf: ArrayBuffer, progress?: (stage: string, f: number) => void): Promise<DwgResult> {
  const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(6, buf.byteLength)));
  if (!/^AC\d{4}$/.test(head)) throw new Error('This is not a DWG file (no AutoCAD signature).');
  progress?.('Reading DWG', 0.15);
  const { DwgReader, DxfWriter } = await import('@node-projects/acad-ts');
  const notes: string[] = [];
  const onNote = (_s: unknown, e: { message?: string }) => { if (e?.message && notes.length < 50) notes.push(e.message); };
  let doc;
  try { doc = DwgReader.readFromStream(buf, onNote as any); }
  catch (e: any) {
    throw new Error(`This DWG (${head}) could not be decoded: ${String(e?.message ?? e).slice(0, 160)}. Saving it as DXF from your CAD program will always work.`);
  }
  progress?.('Converting to DXF', 0.55);
  const sink = new Utf8Sink();
  DxfWriter.writeToStream(sink as any, doc, false, undefined, onNote as any);
  return { dxf: sink.bytes(), version: head, notes };
}
