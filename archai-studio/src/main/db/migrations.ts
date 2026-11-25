/**
 * Database migrations, applied in order. Never edit a released migration;
 * add a new one instead. PRAGMA user_version records the last applied step.
 */
export const MIGRATIONS: string[] = [
  /* 1: projects */ `
  CREATE TABLE projects (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    archived    INTEGER NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX projects_name_active ON projects(lower(name)) WHERE archived = 0;
  CREATE TABLE settings_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  /* 2: chat threads and messages */ `
  CREATE TABLE threads (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects(id),
    kind        TEXT NOT NULL DEFAULT 'chat',
    title       TEXT NOT NULL,
    model       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX threads_project ON threads(project_id, kind, updated_at);
  CREATE TABLE messages (
    id          INTEGER PRIMARY KEY,
    thread_id   INTEGER NOT NULL REFERENCES threads(id),
    role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
    content     TEXT NOT NULL,
    thinking    TEXT,
    meta        TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX messages_thread ON messages(thread_id, id);
  `
]
