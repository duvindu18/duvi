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
  `,
  /* 3: saved scripts */ `
  CREATE TABLE scripts (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects(id),
    target      TEXT NOT NULL,
    title       TEXT NOT NULL,
    code        TEXT NOT NULL,
    path        TEXT,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX scripts_project ON scripts(project_id, created_at);
  `,
  /* 4: images and imported ComfyUI workflows */ `
  CREATE TABLE images (
    id          INTEGER PRIMARY KEY,
    project_id  INTEGER NOT NULL REFERENCES projects(id),
    path        TEXT NOT NULL,
    width       INTEGER,
    height      INTEGER,
    positive    TEXT NOT NULL,
    negative    TEXT NOT NULL,
    seed        INTEGER NOT NULL,
    model       TEXT,
    workflow    TEXT NOT NULL,
    mode        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    trashed     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX images_project ON images(project_id, trashed, created_at);
  CREATE TABLE workflows (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    mode        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    json        TEXT NOT NULL,
    bindings    TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  `
]
