// On-device file library: opened files are kept in IndexedDB so they reopen with no signal,
// and notes/measurements are stored per file. Nothing is uploaded anywhere.

export interface StoredFile { id: string; name: string; size: number; opened: number; data: ArrayBuffer }
export interface Note { id: string; x: number; y: number; z: number; text: string; created: number }
export interface Measure { id: string; pts: [number, number, number][]; kind: 'dist' | 'area' }
export interface FileMeta { notes: Note[]; measures: Measure[] }

const DB = 'cadview';
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  return (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('files', { keyPath: 'id' });
      r.result.createObjectStore('meta');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((res, rej) => {
        const req = fn(d.transaction(store, mode).objectStore(store));
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      }),
  );
}

/** Stable id from content, so the same drawing keeps its notes even if renamed. */
export function fileId(name: string, data: ArrayBuffer): string {
  const b = new Uint8Array(data);
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(b.length / 65536));
  for (let i = 0; i < b.length; i += step) h = Math.imul(h ^ b[i], 0x01000193) >>> 0;
  return `${b.length.toString(36)}-${h.toString(36)}-${name.split('.').pop()}`;
}

export async function saveFile(f: StoredFile) {
  try { await tx('files', 'readwrite', (s) => s.put(f)); } catch { /* storage full or blocked: viewing still works */ }
}
export async function listFiles(): Promise<Omit<StoredFile, 'data'>[]> {
  try {
    const all = await tx<StoredFile[]>('files', 'readonly', (s) => s.getAll());
    return all.map(({ data, ...rest }) => rest).sort((a, b) => b.opened - a.opened);
  } catch { return []; }
}
export async function getFile(id: string): Promise<StoredFile | undefined> {
  try { return await tx('files', 'readonly', (s) => s.get(id)); } catch { return undefined; }
}
export async function deleteFile(id: string) {
  try {
    await tx('files', 'readwrite', (s) => s.delete(id));
    await tx('meta', 'readwrite', (s) => s.delete(id));
  } catch { /* ignore */ }
}
export async function getMeta(id: string): Promise<FileMeta> {
  try { return (await tx<FileMeta>('meta', 'readonly', (s) => s.get(id))) ?? { notes: [], measures: [] }; }
  catch { return { notes: [], measures: [] }; }
}
export async function saveMeta(id: string, m: FileMeta) {
  try { await tx('meta', 'readwrite', (s) => s.put(m, id)); } catch { /* ignore */ }
}
