import type { ConfigStore } from './config/config'
import type { Manager } from './engines/manager'
import type { Registry } from './engines/registry'
import type { Scanner } from './models/scanner'

export interface Deps {
  store: ConfigStore
  registry: Registry
  manager: Manager
  scanner: Scanner
  version: string
  startedAt: number
}
