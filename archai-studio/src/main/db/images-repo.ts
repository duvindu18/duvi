import type { ApiWorkflow, Bindings, ImageMode, WorkflowInfo } from '@shared/images'
import type { Db } from './database'

export interface ImageRow {
  id: number
  project_id: number
  path: string
  width: number | null
  height: number | null
  positive: string
  negative: string
  seed: number
  model: string | null
  workflow: string
  mode: ImageMode
  description: string
  created_at: string
}

export type NewImage = Omit<ImageRow, 'id' | 'created_at'>

export class ImagesRepo {
  constructor(private readonly db: Db) {}

  list(projectId: number): ImageRow[] {
    return this.db.prepare('SELECT * FROM images WHERE project_id = ? AND trashed = 0 ORDER BY created_at DESC, id DESC').all(projectId) as ImageRow[]
  }

  get(id: number): ImageRow | null {
    return (this.db.prepare('SELECT * FROM images WHERE id = ? AND trashed = 0').get(id) as ImageRow | undefined) ?? null
  }

  add(i: NewImage): ImageRow {
    const info = this.db
      .prepare(
        'INSERT INTO images (project_id, path, width, height, positive, negative, seed, model, workflow, mode, description) VALUES (@project_id, @path, @width, @height, @positive, @negative, @seed, @model, @workflow, @mode, @description)'
      )
      .run(i)
    return this.get(Number(info.lastInsertRowid))!
  }

  markTrashed(id: number): void {
    this.db.prepare('UPDATE images SET trashed = 1 WHERE id = ?').run(id)
  }

  /* imported workflows */

  workflows(): (WorkflowInfo & { json: ApiWorkflow })[] {
    const rows = this.db.prepare('SELECT * FROM workflows ORDER BY created_at').all() as { id: string; name: string; mode: ImageMode; description: string; json: string; bindings: string }[]
    return rows.map((r) => ({ id: r.id, name: r.name, mode: r.mode, description: r.description, builtIn: false, bindings: JSON.parse(r.bindings) as Bindings, json: JSON.parse(r.json) as ApiWorkflow }))
  }

  addWorkflow(id: string, name: string, mode: ImageMode, description: string, json: ApiWorkflow, bindings: Bindings): void {
    this.db.prepare('INSERT INTO workflows (id, name, mode, description, json, bindings) VALUES (?, ?, ?, ?, ?, ?)').run(id, name, mode, description, JSON.stringify(json), JSON.stringify(bindings))
  }
}
