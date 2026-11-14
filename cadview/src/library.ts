// On-device library. File bytes live in their own store (as Blobs, which browsers keep on disk)
// and a small index holds names, sizes and thumbnails, so listing never loads big files.

export interface FileInfo { id: string; name: string; size: number; opened: number; thumb?: string }
export interface Note { id: string; x: number; y: number; z: number; text: string; created: number }
export interface Measure { id: string; pts: [number, number, number][]; kind: 'dist' | 'area' }
export interface FileMeta { notes: Note[]; measures: Measure[]; units?: string; view?: unknown }

let dbp: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open('cadview-lib', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('blobs');
      r.result.createObjectStore('index', { keyPath: 'id' });
      r.result.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
function req<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((res, rej) => {
    const t = d.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r.result);
    t.onerror = t.onabort = () => rej(t.error ?? r.error);
  }));
}

/** Stable id from content (sampled), so the same drawing keeps its notes even if renamed. */
export function fileId(name: string, data: ArrayBuffer): string {
  const b = new Uint8Array(data);
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(b.length / 65536));
  for (let i = 0; i < b.length; i += step) h = Math.imul(h ^ b[i], 0x01000193) >>> 0;
  return `${b.length.toString(36)}-${h.toString(36)}-${(name.split('.').pop() ?? '').toLowerCase()}`;
}

let persisted = false;
export async function saveFile(info: FileInfo, data: Blob) {
  try {
    if (!persisted) { persisted = true; await navigator.storage?.persist?.(); } // ask the OS not to evict our files
    await req('blobs', 'readwrite', (s) => s.put(data, info.id));
    await req('index', 'readwrite', (s) => s.put(info));
  } catch { /* storage full or blocked: viewing still works */ }
}
export async function touch(id: string, patch: Partial<FileInfo>) {
  try {
    const cur = await req<FileInfo | undefined>('index', 'readonly', (s) => s.get(id));
    if (cur) await req('index', 'readwrite', (s) => s.put({ ...cur, ...patch }));
  } catch { /* ignore */ }
}
export async function listFiles(): Promise<FileInfo[]> {
  try { return (await req<FileInfo[]>('index', 'readonly', (s) => s.getAll())).sort((a, b) => b.opened - a.opened); }
  catch { return []; }
}
export async function getData(id: string): Promise<ArrayBuffer | null> {
  try { const b = await req<Blob | undefined>('blobs', 'readonly', (s) => s.get(id)); return b ? await b.arrayBuffer() : null; }
  catch { return null; }
}
export async function deleteFile(id: string) {
  try {
    await req('blobs', 'readwrite', (s) => s.delete(id));
    await req('index', 'readwrite', (s) => s.delete(id));
    await req('meta', 'readwrite', (s) => s.delete(id));
  } catch { /* ignore */ }
}
export async function getMeta(id: string): Promise<FileMeta> {
  try { return (await req<FileMeta | undefined>('meta', 'readonly', (s) => s.get(id))) ?? { notes: [], measures: [] }; }
  catch { return { notes: [], measures: [] }; }
}
export async function saveMeta(id: string, m: FileMeta) {
  try { await req('meta', 'readwrite', (s) => s.put(m, id)); } catch { /* ignore */ }
}
export async function storageInfo(): Promise<{ used: number; quota: number } | null> {
  try { const e = await navigator.storage?.estimate?.(); return e ? { used: e.usage ?? 0, quota: e.quota ?? 0 } : null; } catch { return null; }
}
