import type { ConfigStore } from './config/config'
import type { Manager } from './engines/manager'
import type { ComfyGuard } from './engines/comfy-guard'
import type { Registry } from './engines/registry'
import type { ProvisionState } from './engines/provision-state'
import type { Scanner } from './models/scanner'
import type { HashStore } from './models/hashes'
import type { ConversationStore } from './chat/db'
import type { HfClient } from './hf/hf'
import type { DownloadManager } from './downloads/downloads'
import type { BenchRunner } from './bench/bench'
import type { ModelRouter } from './gateway/model-router'
import type { ToolRegistry } from './tools/tool-registry'

export interface Deps {
  store: ConfigStore
  registry: Registry
  manager: Manager
  scanner: Scanner
  hashes: HashStore
  db: ConversationStore
  provision: ProvisionState
  hf: HfClient
  downloads: DownloadManager
  bench: BenchRunner
  /** Gateway model router (v0.6.0): auto model-swap and keep-N pool. */
  modelRouter: ModelRouter
  /** Tool registry (v0.7.0): built-in tools + MCP host. Optional — absent in tests. */
  tools?: ToolRegistry
  /** ComfyUI GPU coordinator (spec: unload/block while ComfyUI renders, reload after).
   *  Optional: only wired in the real `serve()` entrypoint (cli.ts); absent under tests. */
  comfy?: ComfyGuard
  version: string
  startedAt: number
  /** Re-exec the daemon so config changes (port, LAN bind) take effect (spec 08 §2).
   *  Gracefully stops the engine, releases the listen socket, then spawns a detached
   *  replacement and exits. Optional: only wired in the real `serve()` entrypoint
   *  (cli.ts); absent under tests, where the restart route returns 501. */
  requestRestart?: () => void
  /** Re-point the HTTP listener at the host/port the config now wants, WITHOUT a full
   *  restart — keeps the engine + model loaded. Used for LAN/port changes. Wired only
   *  in the real `serve()` entrypoint (cli.ts); absent under tests. */
  rebind?: () => void
}
