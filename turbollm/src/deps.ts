import type { ConfigStore } from './config/config'
import type { Manager } from './engines/manager'
import type { Registry } from './engines/registry'
import type { ProvisionState } from './engines/provision-state'
import type { Scanner } from './models/scanner'
import type { ConversationStore } from './chat/db'

export interface Deps {
  store: ConfigStore
  registry: Registry
  manager: Manager
  scanner: Scanner
  db: ConversationStore
  provision: ProvisionState
  version: string
  startedAt: number
}
