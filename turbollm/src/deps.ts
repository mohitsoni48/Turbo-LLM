import type { ConfigStore } from './config/config'
import type { Manager } from './engines/manager'
import type { Registry } from './engines/registry'
import type { ProvisionState } from './engines/provision-state'
import type { Scanner } from './models/scanner'
import type { ConversationStore } from './chat/db'
import type { HfClient } from './hf/hf'
import type { DownloadManager } from './downloads/downloads'

export interface Deps {
  store: ConfigStore
  registry: Registry
  manager: Manager
  scanner: Scanner
  db: ConversationStore
  provision: ProvisionState
  hf: HfClient
  downloads: DownloadManager
  version: string
  startedAt: number
  /** Re-exec the daemon so config changes (port, LAN bind) take effect (spec 08 §2).
   *  Gracefully stops the engine, releases the listen socket, then spawns a detached
   *  replacement and exits. Optional: only wired in the real `serve()` entrypoint
   *  (cli.ts); absent under tests, where the restart route returns 501. */
  requestRestart?: () => void
}
