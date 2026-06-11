import { serve } from '@hono/node-server'
import { ConfigStore, defaultConfigPath } from './config/config'
import { Manager, type StartOpts } from './engines/manager'
import { Registry } from './engines/registry'
import { Scanner } from './models/scanner'
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
void registry.ensureProbed()
const manager = new Manager(store)
const scanner = new Scanner(store)
void scanner.rescan() // discover models in the background
const startedAt = Date.now()
const app = createApp({ store, registry, manager, scanner, version, startedAt })

const cfg = store.snapshot()
const addr = argValue('--addr', `${cfg.daemon.host}:${cfg.daemon.port}`)
const lastColon = addr.lastIndexOf(':')
const host = addr.slice(0, lastColon) || '127.0.0.1'
const port = Number(addr.slice(lastColon + 1)) || 8080

const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`TurboLLM ${version} listening on http://${host}:${info.port}`)
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
    void manager.shutdown().finally(() => server.close(() => process.exit(0)))
    setTimeout(() => process.exit(0), 12_000).unref()
  })
}
