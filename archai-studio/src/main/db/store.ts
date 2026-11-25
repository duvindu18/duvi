/**
 * Opens the database lazily, the first time projects are needed. The first-run
 * wizard can therefore change the data folder before anything is written to disk.
 */
import { join } from 'node:path'
import { DB_FILE } from '../paths'
import { log } from '../log'
import { openDatabase, type Db } from './database'
import { ProjectsRepo } from './projects-repo'

export class DataStore {
  private db: Db | null = null
  private repo: ProjectsRepo | null = null
  private openedAt: string | null = null

  constructor(private readonly dataDir: () => string) {}

  projects(): ProjectsRepo {
    if (!this.repo) {
      const dir = this.dataDir()
      this.db = openDatabase(join(dir, DB_FILE))
      this.openedAt = dir
      this.repo = new ProjectsRepo(this.db)
      log.info(`database opened in ${dir}`)
    }
    return this.repo
  }

  /** The folder the open database lives in (null until first use). */
  openFolder(): string | null {
    return this.openedAt
  }

  close(): void {
    this.db?.close()
    this.db = null
    this.repo = null
  }
}
