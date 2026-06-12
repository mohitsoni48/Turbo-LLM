import { serve } from '@hono/node-server'
import { join } from 'node:path'
import { ConfigStore, defaultConfigPath } from './config/config'
import { Manager, type StartOpts } from './engines/manager'
import { Registry } from './engines/registry'
import { ProvisionState } from './engines/provision-state'
import { seedDefaultEngines } from './engines/seed'
import { Scanner } from './models/scanner'
import { ConversationStore } from './chat/db'
import { createApp } from './server'

// Entrypoint for the TurboLLM daemon (npm bin "turbollm"): wiring + graceful
// shutdown. ADR-023 (Node/TS stack).
const version = '0.0.0-dev'

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

const store = ConfigStore.load(argValue('--config', defaultConfigPath()))
if (store.brokenBackup()) {
  console.warn(`config was reset; previous file backed up at ${store.brokenBackup()}`)
}

const registry = new Registry(store)
const provision = new ProvisionState()
const enginesDir = join(store.dir(), 'engines')
void seedDefaultEngines(registry, enginesDir, provision).then(() => registry.ensureProbed())
const manager = new Manager(store)
const scanner = new Scanner(store)
void scanner.rescan() // discover models in the background
const db = new ConversationStore(store.dir())
const startedAt = Date.now()
const app = createApp({ store, registry, manager, scanner, db, provision, version, startedAt })

const cfg = store.snapshot()
const defaultHost = cfg.daemon.lanBind ? '0.0.0.0' : (cfg.daemon.host || '127.0.0.1')
const addr = argValue('--addr', `${defaultHost}:${cfg.daemon.port}`)
const lastColon = addr.lastIndexOf(':')
const host = addr.slice(0, lastColon) || '127.0.0.1'
const port = Number(addr.slice(lastColon + 1)) || 6996

const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  const displayHost = host === '0.0.0.0' ? '0.0.0.0 (LAN)' : host
  console.log(`TurboLLM ${version} listening on http://${displayHost}:${info.port}`)
})

// Optionally restore the last engine/model on start (spec 05 §7).
if (cfg.autoLoadOnStart && cfg.devModel) {
  const active = registry.active()
  if (active) {
    const opts: StartOpts = {
      engine: active,
      model: { key: cfg.devModel.modelPath, name: cfg.devModel.label, quant: '', ctx: 0, vision: false },
      modelPath: cfg.devModel.modelPath,
      extraArgs: cfg.devModel.extraArgs,
    }
    manager.start(opts).catch((e) => console.warn(`auto-load failed: ${e}`))
  }
}

let shuttingDown = false
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    if (shuttingDown) return
    shuttingDown = true
    console.log('shutting down')
    void manager.shutdown().finally(() => { db.close(); server.close(() => process.exit(0)) })
    setTimeout(() => process.exit(0), 12_000).unref()
  })
}
