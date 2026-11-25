import type { ChatMessage, MessageMeta, Thread } from '@shared/chat'
import type { Db } from './database'

interface ThreadRow {
  id: number
  project_id: number
  title: string
  model: string
  created_at: string
  updated_at: string
}
interface MessageRow {
  id: number
  thread_id: number
  role: 'user' | 'assistant'
  content: string
  thinking: string | null
  meta: string | null
  created_at: string
}

const toThread = (r: ThreadRow): Thread => ({ id: r.id, projectId: r.project_id, title: r.title, model: r.model, createdAt: r.created_at, updatedAt: r.updated_at })
const toMessage = (r: MessageRow): ChatMessage => ({
  id: r.id,
  threadId: r.thread_id,
  role: r.role,
  content: r.content,
  thinking: r.thinking,
  meta: r.meta ? (JSON.parse(r.meta) as MessageMeta) : null,
  createdAt: r.created_at
})

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`

/** Chat threads belong to a project. `kind` separates Chat from Script Studio (M4). */
export class ChatRepo {
  constructor(private readonly db: Db) {}

  threads(projectId: number, kind = 'chat'): Thread[] {
    return (this.db.prepare('SELECT * FROM threads WHERE project_id = ? AND kind = ? ORDER BY updated_at DESC, id DESC').all(projectId, kind) as ThreadRow[]).map(toThread)
  }

  thread(id: number): Thread | null {
    const r = this.db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined
    return r ? toThread(r) : null
  }

  createThread(projectId: number, title: string, model: string, kind = 'chat'): Thread {
    const info = this.db.prepare('INSERT INTO threads (project_id, kind, title, model) VALUES (?, ?, ?, ?)').run(projectId, kind, title, model)
    return this.thread(Number(info.lastInsertRowid))!
  }

  touch(threadId: number, model: string): void {
    this.db.prepare(`UPDATE threads SET updated_at = ${NOW}, model = ? WHERE id = ?`).run(model, threadId)
  }

  rename(threadId: number, title: string): Thread {
    this.db.prepare('UPDATE threads SET title = ? WHERE id = ?').run(title, threadId)
    const t = this.thread(threadId)
    if (!t) throw new Error('That chat no longer exists.')
    return t
  }

  messages(threadId: number): ChatMessage[] {
    return (this.db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY id').all(threadId) as MessageRow[]).map(toMessage)
  }

  addMessage(threadId: number, role: 'user' | 'assistant', content: string, thinking: string | null = null, meta: MessageMeta | null = null): ChatMessage {
    const info = this.db
      .prepare('INSERT INTO messages (thread_id, role, content, thinking, meta) VALUES (?, ?, ?, ?, ?)')
      .run(threadId, role, content, thinking, meta ? JSON.stringify(meta) : null)
    const r = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(info.lastInsertRowid)) as MessageRow
    return toMessage(r)
  }
}
