import type { SavedScript, ScriptTarget } from '@shared/scripts'
import type { Db } from './database'

interface Row {
  id: number
  project_id: number
  target: ScriptTarget
  title: string
  code: string
  path: string | null
  created_at: string
}
const to = (r: Row): SavedScript => ({ id: r.id, projectId: r.project_id, target: r.target, title: r.title, code: r.code, path: r.path, createdAt: r.created_at })

export class ScriptsRepo {
  constructor(private readonly db: Db) {}

  list(projectId: number): SavedScript[] {
    return (this.db.prepare('SELECT * FROM scripts WHERE project_id = ? ORDER BY created_at DESC, id DESC').all(projectId) as Row[]).map(to)
  }

  add(projectId: number, target: ScriptTarget, title: string, code: string, path: string | null): SavedScript {
    const info = this.db.prepare('INSERT INTO scripts (project_id, target, title, code, path) VALUES (?, ?, ?, ?, ?)').run(projectId, target, title, code, path)
    return to(this.db.prepare('SELECT * FROM scripts WHERE id = ?').get(Number(info.lastInsertRowid)) as Row)
  }
}
