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
  `
]
