import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { openDatabase, migrate, type Db } from '../../src/main/db/database'
import { MIGRATIONS } from '../../src/main/db/migrations'
import { ProjectsRepo } from '../../src/main/db/projects-repo'

describe('projects', () => {
  let db: Db
  let repo: ProjectsRepo
  beforeEach(() => {
    db = openDatabase(':memory:')
    repo = new ProjectsRepo(db)
  })

  it('creates, lists, renames', () => {
    const k = repo.create('  Kandy Residence ')
    expect(k.name).toBe('Kandy Residence')
    repo.create('Galle Fort Boutique Hotel')
    expect(repo.list().map((p) => p.name)).toContain('Kandy Residence')
    expect(repo.rename(k.id, 'Kandy Residence, Phase 2').name).toBe('Kandy Residence, Phase 2')
  })

  it('refuses duplicate names (any case) among active projects', () => {
    repo.create('Kandy Residence')
    expect(() => repo.create('kandy residence')).toThrow(/already exists/)
  })

  it('archives without deleting, and frees the name', () => {
    const p = repo.create('Negombo Villa')
    repo.setArchived(p.id, true)
    expect(repo.list()).toHaveLength(0)
    expect(repo.list(true)).toHaveLength(1)
    expect(repo.create('Negombo Villa').id).not.toBe(p.id)
    expect(() => repo.setArchived(p.id, false)).toThrow(/already exists/)
  })

  it('reports missing projects clearly', () => {
    expect(() => repo.rename(999, 'x')).toThrow(/no longer exists/)
  })

  it('migrations are idempotent and versioned', () => {
    expect(migrate(db)).toBe(MIGRATIONS.length)
    expect(db.pragma('user_version', { simple: true })).toBe(MIGRATIONS.length)
  })

  it('refuses a database from a newer app version', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'archai-db-')), 'a.db')
    const d = openDatabase(file)
    d.pragma('user_version = 999')
    d.close()
    expect(() => openDatabase(file)).toThrow(/newer version/)
  })

  it('uses WAL on disk', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'archai-db-')), 'a.db')
    expect(openDatabase(file).pragma('journal_mode', { simple: true })).toBe('wal')
  })
})
