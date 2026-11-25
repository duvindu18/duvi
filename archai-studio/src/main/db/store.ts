/**
 * Opens the database lazily, the first time projects are needed. The first-run
 * wizard can therefore change the data folder before anything is written to disk.
 */
import { join } from 'node:path'
import { DB_FILE } from '../paths'
import { log } from '../log'
import { openDatabase, type Db } from './database'
import { ChatRepo } from './chat-repo'
import { ImagesRepo } from './images-repo'
import { ProjectsRepo } from './projects-repo'
import { ScriptsRepo } from './scripts-repo'

export class DataStore {
  private db: Db | null = null
  private repo: ProjectsRepo | null = null
  private chatRepo: ChatRepo | null = null
  private scriptsRepo: ScriptsRepo | null = null
  private imagesRepo: ImagesRepo | null = null
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

  chats(): ChatRepo {
    this.projects()
    this.chatRepo ??= new ChatRepo(this.db!)
    return this.chatRepo
  }

  scripts(): ScriptsRepo {
    this.projects()
    this.scriptsRepo ??= new ScriptsRepo(this.db!)
    return this.scriptsRepo
  }

  images(): ImagesRepo {
    this.projects()
    this.imagesRepo ??= new ImagesRepo(this.db!)
    return this.imagesRepo
  }

  /** The folder the open database lives in (null until first use). */
  openFolder(): string | null {
    return this.openedAt
  }

  close(): void {
    this.db?.close()
    this.db = null
    this.repo = null
    this.chatRepo = null
    this.scriptsRepo = null
    this.imagesRepo = null
  }
}
