import type { Project } from '@shared/projects'
import type { Db } from './database'

interface Row {
  id: number
  name: string
  created_at: string
  updated_at: string
  archived: number
}

const toProject = (r: Row): Project => ({ id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at, archived: r.archived === 1 })

export class ProjectNameTaken extends Error {
  constructor(name: string) {
    super(`A project called "${name}" already exists. Choose another name.`)
  }
}

export class ProjectsRepo {
  constructor(private readonly db: Db) {}

  list(includeArchived = false): Project[] {
    const sql = `SELECT * FROM projects ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY updated_at DESC, id DESC`
    return (this.db.prepare(sql).all() as Row[]).map(toProject)
  }

  get(id: number): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
    return row ? toProject(row) : null
  }

  create(name: string): Project {
    try {
      const info = this.db.prepare('INSERT INTO projects (name) VALUES (?)').run(name.trim())
      return this.get(Number(info.lastInsertRowid))!
    } catch (e) {
      if (isUniqueError(e)) throw new ProjectNameTaken(name.trim())
      throw e
    }
  }

  rename(id: number, name: string): Project {
    try {
      const info = this.db
        .prepare(`UPDATE projects SET name = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(name.trim(), id)
      if (info.changes === 0) throw new Error('That project no longer exists.')
      return this.get(id)!
    } catch (e) {
      if (isUniqueError(e)) throw new ProjectNameTaken(name.trim())
      throw e
    }
  }

  /** Archiving hides a project; it never deletes anything. */
  setArchived(id: number, archived: boolean): Project {
    try {
      const info = this.db
        .prepare(`UPDATE projects SET archived = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(archived ? 1 : 0, id)
      if (info.changes === 0) throw new Error('That project no longer exists.')
      return this.get(id)!
    } catch (e) {
      if (isUniqueError(e)) throw new ProjectNameTaken(this.get(id)?.name ?? '')
      throw e
    }
  }
}

function isUniqueError(e: unknown): boolean {
  return e instanceof Error && 'code' in e && (e as { code: string }).code === 'SQLITE_CONSTRAINT_UNIQUE'
}
