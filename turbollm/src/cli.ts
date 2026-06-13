import { spawn } from 'node:child_process'
import { serve } from '@hono/node-server'
import { join } from 'node:path'
import { ConfigStore, defaultConfigPath, migrateLegacyDataDir } from './config/config'
import { Manager, type StartOpts } from './engines/manager'
import { Registry } from './engines/registry'
import { ProvisionState } from './engines/provision-state'
import { seedDefaultEngines } from './engines/seed'
import { Scanner } from './models/scanner'
import { resolveProfile, profileToArgs, type LoadProfile } from './models/profile'
import { getSysInfo } from './sysinfo/sysinfo'
import { ConversationStore } from './chat/db'
import { HfClient } from './hf/hf'
import { DownloadManager } from './downloads/downloads'
import { BenchRunner } from './bench/bench'
import { launchCli } from './cli-launch'
import { createApp } from './server'
import type { Deps } from './deps'

// Entrypoint for the TurboLLM daemon (npm bin "turbollm"): wiring + graceful
// shutdown. ADR-023 (Node/TS stack).
const version = '0.0.0-dev'

// ── Node version guard ────────────────────────────────────────────────────────
const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 22) {
  process.stderr.write(
    `TurboLLM requires Node.js 22 or newer.\n` +
    `You are running Node.js ${process.versions.node}.\n` +
    `Please upgrade: https://nodejs.org\n`,
  )
  process.exit(1)
}

// ── Arg helpers ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)

function hasFlag(...names: string[]): boolean {
  return names.some((n) => argv.includes(n))
}

function argValue(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}

// ── `turbollm launch <cli>` — start a coding CLI wired to TurboLLM ──────────────
// Handled before --help so `turbollm launch claude --help` forwards --help to the
// launched CLI rather than printing TurboLLM's help.
if (argv[0] === 'launch') {
  const target = argv[1] ?? ''
  const port = Number(argValue('--port', '')) || 6996
  // Everything after `launch <cli>` is forwarded to the CLI, minus our own --port.
  const passthrough = argv.slice(2).filter((a, i, arr) => a !== '--port' && arr[i - 1] !== '--port')
  const code = await launchCli(target, port, passthrough)
  process.exit(code)
}

// ── --help / -h ───────────────────────────────────────────────────────────────
if (hasFlag('--help', '-h')) {
  process.stdout.write(
    `\nTurboLLM ${version} — local LLM platform\n\n` +
    `Usage:\n` +
    `  npx turbollm [options]\n` +
    `  turbollm [options]\n` +
    `  turbollm launch <cli>            # run a coding CLI on your local model\n\n` +
    `Commands:\n` +
    `  launch claude                    Launch Claude Code wired to TurboLLM\n` +
    `                                   (daemon must be running with a model loaded)\n\n` +
    `Options:\n` +
    `  --port <n>     Port to listen on / connect to (default: 6996)\n` +
    `  --addr <h:p>   Full host:port override (e.g. 0.0.0.0:6996)\n` +
    `  --no-open      Do not open a browser window on startup\n` +
    `  --config <f>   Path to a custom config file\n` +
    `  --help, -h     Show this help message\n\n` +
    `Examples:\n` +
    `  npx turbollm                     # start on default port, open browser\n` +
    `  turbollm --port 9000             # listen on port 9000\n` +
    `  turbollm --no-open               # start without opening a browser\n` +
    `  turbollm --addr 0.0.0.0:6996    # bind to all interfaces (LAN sharing)\n` +
    `  turbollm launch claude           # open Claude Code on your loaded model\n\n`,
  )
  process.exit(0)
}

// ── Config + registry ─────────────────────────────────────────────────────────
// Default location → relocate any pre-0.x state into ~/.turbollm first. A
// `--config` override is an explicit choice (dev/preview), so leave it untouched.
if (!process.argv.includes('--config')) migrateLegacyDataDir()
const store = ConfigStore.load(argValue('--config', defaultConfigPath()))
if (store.brokenBackup()) {
  console.warn(`config was reset; previous file backed up at ${store.brokenBackup()}`)
}

const registry = new Registry(store)
const pruned = registry.pruneDeadManagedBuilds()
if (pruned > 0) console.log(`pruned ${pruned} dangling engine build(s)`)
const provision = new ProvisionState()
const enginesDir = join(store.dir(), 'engines')
void seedDefaultEngines(registry, enginesDir, provision).then(() => registry.ensureProbed())
const manager = new Manager(store)
const scanner = new Scanner(store)
void scanner.rescan() // discover models in the background
const db = new ConversationStore(store.dir())
const hf = new HfClient(() => store.snapshot().hf.token, version)
// A completed download triggers a rescan so the new model shows up in the library.
const downloads = new DownloadManager(store, () => void scanner.rescan(), () => hf.authHeaders())
// Auto-benchmark + auto-tune runner (Differentiator #2, spec 09). Owns the engine
// exclusively for a run; reuses manager/profile control rather than reimplementing it.
const bench = new BenchRunner(manager, store, scanner, registry, version)
const startedAt = Date.now()
// `requestRestart` is attached after the server is created (it must close over it).
const deps: Deps = { store, registry, manager, scanner, db, provision, hf, downloads, bench, version, startedAt }
const app = createApp(deps)

// ── Resolve listen address ────────────────────────────────────────────────────
const cfg = store.snapshot()
const defaultHost = cfg.daemon.lanBind ? '0.0.0.0' : (cfg.daemon.host || '127.0.0.1')

// --port <n> is a convenience shorthand; --addr <h:p> is the full override.
const portFlag = argValue('--port', '')
let addr: string
if (portFlag) {
  addr = `${defaultHost}:${portFlag}`
} else {
  addr = argValue('--addr', `${defaultHost}:${cfg.daemon.port}`)
}
const lastColon = addr.lastIndexOf(':')
const host = addr.slice(0, lastColon) || '127.0.0.1'
const port = Number(addr.slice(lastColon + 1)) || 6996

// ── Cross-platform browser open ───────────────────────────────────────────────
function openBrowser(url: string): void {
  let cmd: string
  let args: string[]
  if (process.platform === 'win32') {
    // `start` is a shell built-in; must go through cmd.exe.
    // The empty string after `start` is the window title (required when the
    // first arg might look like a flag to cmd).
    cmd = 'cmd'
    args = ['/c', 'start', '', url]
  } else if (process.platform === 'darwin') {
    cmd = 'open'
    args = [url]
  } else {
    cmd = 'xdg-open'
    args = [url]
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  child.unref()
  child.on('error', () => {
    // Opening the browser is best-effort — never crash the daemon over it.
    console.log(`  Could not open browser automatically. Visit the URL above manually.`)
  })
}

// ── Start server ──────────────────────────────────────────────────────────────
const noOpen = hasFlag('--no-open')

const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  const displayHost = host === '0.0.0.0' ? '0.0.0.0 (LAN)' : host
  const uiUrl = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${info.port}`

  console.log(``)
  console.log(`  TurboLLM ${version} is ready!`)
  console.log(``)
  console.log(`  Local:   ${uiUrl}`)
  if (host === '0.0.0.0') {
    console.log(`  Network: http://<your-ip>:${info.port}  (LAN)`)
  }
  console.log(``)
  console.log(`  API:     ${uiUrl}/api/v1/status`)
  console.log(`  Stop:    Ctrl+C`)
  console.log(``)

  if (!noOpen) {
    openBrowser(uiUrl)
  }

  // Keep the legacy one-liner for log parsers that key on it.
  process.stdout.write(`TurboLLM ${version} listening on http://${displayHost}:${info.port}\n`)
})

// ── Self-restart (spec 08 §2) ──────────────────────────────────────────────────
// POST /api/v1/daemon/restart re-execs the daemon so port / LAN-bind changes take
// effect without the user killing the terminal. Ordering is what makes this safe:
//   1. stop the engine,
//   2. force open keep-alive sockets shut (SSE log/chat streams would otherwise hold
//      the listen socket open forever and block server.close),
//   3. close the server so the OLD process releases the port,
//   4. ONLY THEN spawn the detached replacement → no port-bind race,
//   5. exit.
// A watchdog spawns + exits anyway if close hasn't completed in time. Fail-safe:
// on any thrown error we still spawn + exit, so the user is never left daemonless.
let restarting = false
function spawnReplacement(): void {
  // Re-exec with the SAME interpreter + argv (minus argv[0]=node) and cwd, detached
  // so it outlives this dying parent. `unref()` lets the parent exit immediately.
  const child = spawn(process.execPath, process.argv.slice(1), {
    cwd: process.cwd(),
    detached: true,
    stdio: 'inherit',
  })
  child.unref()
}
deps.requestRestart = () => {
  if (restarting) return
  restarting = true
  let spawned = false
  const finish = () => {
    if (spawned) return
    spawned = true
    try {
      spawnReplacement()
    } catch (e) {
      console.warn(`restart spawn failed: ${e}`)
    }
    process.exit(0)
  }
  // Watchdog: if graceful teardown stalls (e.g. a socket refuses to drain), restart
  // anyway. 4s is comfortably under the UI's ~10s recovery budget (spec 08 §A8).
  const watchdog = setTimeout(finish, 4_000)
  watchdog.unref()
  try {
    void manager.shutdown().finally(() => {
      try {
        db.close()
      } catch {
        /* best-effort */
      }
      // Drop keep-alive connections first so close()'s callback can actually fire.
      // closeAllConnections exists on Node 18.2+ http servers; guard for safety.
      const s = server as unknown as { closeAllConnections?: () => void }
      try {
        s.closeAllConnections?.()
      } catch {
        /* best-effort */
      }
      server.close(() => {
        clearTimeout(watchdog)
        finish()
      })
    })
  } catch (e) {
    // Any synchronous failure in the teardown path: still restart.
    console.warn(`restart teardown failed: ${e}`)
    clearTimeout(watchdog)
    finish()
  }
}

// ── Auto-load last model on start (spec 05 §7) ────────────────────────────────
// When enabled (Settings → Startup), re-load the last-used model so the daemon
// comes back ready to chat. Resolves the saved modelKey through the scanner +
// profile pipeline (same as POST /engine/start); falls back to a legacy devModel.
void (async () => {
  if (!cfg.autoLoadOnStart) return
  const active = registry.active()
  if (!active) return
  await scanner.rescan() // ensure the model list is populated before resolving
  const sys = getSysInfo()
  const entry = cfg.lastLoaded.modelKey ? scanner.get(cfg.lastLoaded.modelKey) : undefined

  let opts: StartOpts | null = null
  if (entry && !entry.incomplete && !entry.parseError && (active.kind === 'mlx') === (entry.format === 'mlx')) {
    if (entry.format === 'mlx') {
      opts = {
        engine: active,
        model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: entry.nativeCtx, vision: false },
        modelPath: entry.path,
        extraArgs: [],
      }
    } else {
      const saved = cfg.modelProfiles[entry.key] as Partial<LoadProfile> | undefined
      const profile = resolveProfile(entry, sys, saved, undefined, cfg.modelDefaults)
      opts = {
        engine: active,
        model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: profile.ctx, vision: entry.vision },
        modelPath: entry.path,
        extraArgs: profileToArgs(profile, entry, active.capabilities, sys.cores),
      }
    }
  } else if (cfg.devModel) {
    opts = {
      engine: active,
      model: { key: cfg.devModel.modelPath, name: cfg.devModel.label, quant: '', ctx: 0, vision: false },
      modelPath: cfg.devModel.modelPath,
      extraArgs: cfg.devModel.extraArgs,
    }
  }
  if (opts) manager.start(opts).catch((e) => console.warn(`auto-load failed: ${e}`))
})()

// ── Graceful shutdown ─────────────────────────────────────────────────────────
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
