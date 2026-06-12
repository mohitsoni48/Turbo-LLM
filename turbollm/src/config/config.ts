// Config load/save/migrate (spec 01). Ports the verified Go implementation to
// TypeScript. Single-threaded event loop => config.update() is atomic per call,
// so no locking is needed. Unknown JSON fields ride along on `data` and are
// preserved across round-trips for free.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const SCHEMA_VERSION = 2

export interface Capabilities {
  kvTypes: string[]
  flags: string[]
}
export interface Engine {
  id: string
  name: string
  binPath: string
  kind: string
  version: string
  capabilities: Capabilities
  addedAt: string
}
export interface Daemon {
  host: string
  port: number
  lanBind: boolean
  authToken: string
  idleTtlMinutes: number
  openBrowserOnStart: boolean
  theme: string
  autoGenerateTitles: boolean
}
export interface Telemetry {
  level: string
  machineId: string
}
export interface ApiKey {
  id: string
  name: string
  hash: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
}
export interface LastLoaded {
  modelKey: string
  engineId: string
}
export interface HF {
  token: string
}
/** TRANSITIONAL (A1/A2): carries the model path + extra args until the
 *  model/profile system (spec 05, A4) replaces it. */
export interface DevModel {
  modelPath: string
  extraArgs: string[]
  label: string
}
export interface Config {
  version: number
  daemon: Daemon
  telemetry: Telemetry
  apiKeys: ApiKey[]
  engines: Engine[]
  activeEngineId: string
  modelDirs: string[]
  modelProfiles: Record<string, unknown>
  lastLoaded: LastLoaded
  autoLoadOnStart: boolean
  hf: HF
  featuredOverrideUrl: string
  devModel?: DevModel
}

export class ValueError extends Error {
  constructor(
    public field: string,
    msg: string,
  ) {
    super(`${field}: ${msg}`)
    this.name = 'ValueError'
  }
}

function userConfigDir(): string {
  if (process.platform === 'win32') return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
}

export function defaultConfigPath(): string {
  return join(userConfigDir(), 'turbollm', 'config.json')
}

export function defaultConfig(): Config {
  return {
    version: SCHEMA_VERSION,
    daemon: {
      host: '127.0.0.1',
      port: 6996,
      lanBind: false,
      authToken: '',
      idleTtlMinutes: 60,
      openBrowserOnStart: true,
      theme: 'system',
      autoGenerateTitles: true,
    },
    telemetry: { level: 'unset', machineId: '' },
    apiKeys: [],
    engines: [],
    activeEngineId: '',
    modelDirs: [],
    modelProfiles: {},
    lastLoaded: { modelKey: '', engineId: '' },
    autoLoadOnStart: false,
    hf: { token: '' },
    featuredOverrideUrl: '',
  }
}

export class ConfigStore {
  private constructor(
    private data: Config,
    private filePath: string,
    private brokenPath = '',
  ) {}

  static load(path: string): ConfigStore {
    if (!existsSync(path)) {
      const store = new ConfigStore(defaultConfig(), path)
      store.save()
      return store
    }
    let raw: Record<string, unknown>
    const text = readFileSync(path, 'utf8')
    try {
      raw = JSON.parse(text) as Record<string, unknown>
    } catch {
      const backup = `${path}.broken-${Math.floor(Date.now() / 1000)}`
      writeFileSync(backup, text)
      const store = new ConfigStore(defaultConfig(), path, backup)
      store.save()
      return store
    }
    const version = typeof raw.version === 'number' ? raw.version : 0
    const cfg = version < SCHEMA_VERSION ? migrate(raw, version) : (raw as unknown as Config)
    normalize(cfg)
    const store = new ConfigStore(cfg, path)
    store.save() // persist migration/normalization
    return store
  }

  snapshot(): Config {
    return structuredClone(this.data)
  }

  /** Mutate the config under one synchronous call, then validate + persist. */
  update(fn: (c: Config) => void): void {
    const work = structuredClone(this.data)
    fn(work)
    validate(work)
    this.data = work
    this.save()
  }

  dir(): string {
    return dirname(this.filePath)
  }
  path(): string {
    return this.filePath
  }
  brokenBackup(): string {
    return this.brokenPath
  }

  private save(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2))
    renameSync(tmp, this.filePath) // libuv MoveFileEx replaces on Windows
  }
}

// ---- migration & validation ---------------------------------------------

function migrate(raw: Record<string, unknown>, _from: number): Config {
  const cfg = defaultConfig()
  if (typeof raw.host === 'string') cfg.daemon.host = raw.host
  if (typeof raw.port === 'number') cfg.daemon.port = raw.port

  const old = raw.engine as { name?: string; binPath?: string; args?: string[] } | undefined
  if (old?.binPath) {
    const eng: Engine = {
      id: randomUUID(),
      name: old.name || 'llama-server',
      binPath: old.binPath,
      kind: 'llama-server',
      version: '',
      capabilities: { kvTypes: [], flags: [] },
      addedAt: new Date().toISOString(),
    }
    cfg.engines.push(eng)
    cfg.activeEngineId = eng.id
    const { modelPath, extra } = splitLaunchArgs(old.args || [])
    if (modelPath) cfg.devModel = { modelPath, extraArgs: extra, label: old.name || '' }
  }
  cfg.version = SCHEMA_VERSION
  // Preserve any unknown top-level keys from the old file.
  for (const [k, v] of Object.entries(raw)) {
    if (!(k in cfg) && k !== 'engine' && k !== 'host' && k !== 'port') {
      ;(cfg as unknown as Record<string, unknown>)[k] = v
    }
  }
  return cfg
}

/** Extract the model path (after -m/--model) and the remaining args minus the
 *  flags the manager injects itself. */
export function splitLaunchArgs(args: string[]): { modelPath: string; extra: string[] } {
  let modelPath = ''
  const extra: string[] = []
  let skipNext = false
  for (let i = 0; i < args.length; i++) {
    if (skipNext) {
      skipNext = false
      continue
    }
    const a = args[i]
    if (a === '-m' || a === '--model') {
      modelPath = args[i + 1] ?? ''
      skipNext = true
    } else if (a === '--host' || a === '--port') {
      skipNext = true
    } else if (a === '--metrics' || a === '--no-webui') {
      // manager injects these; drop
    } else {
      extra.push(a)
    }
  }
  return { modelPath, extra }
}

function normalize(c: Config): void {
  const d = defaultConfig()
  c.daemon = { ...d.daemon, ...(c.daemon ?? {}) }
  c.telemetry = { ...d.telemetry, ...(c.telemetry ?? {}) }
  c.hf = { ...d.hf, ...(c.hf ?? {}) }
  c.lastLoaded = { ...d.lastLoaded, ...(c.lastLoaded ?? {}) }
  c.apiKeys ??= []
  c.engines ??= []
  c.modelDirs ??= []
  c.modelProfiles ??= {}
  c.autoLoadOnStart ??= false
  c.featuredOverrideUrl ??= ''
  for (const e of c.engines) {
    e.capabilities ??= { kvTypes: [], flags: [] }
    e.capabilities.kvTypes ??= []
    e.capabilities.flags ??= []
  }
  if (c.activeEngineId && !c.engines.some((e) => e.id === c.activeEngineId)) c.activeEngineId = ''
  if (!c.activeEngineId && c.engines.length > 0) c.activeEngineId = c.engines[0].id
  c.version = SCHEMA_VERSION
}

function validate(c: Config): void {
  if (c.daemon.port < 1024 || c.daemon.port > 65535) {
    throw new ValueError('daemon.port', 'port must be 1024–65535')
  }
  for (const dir of c.modelDirs) {
    if (!isAbsolutePath(dir)) throw new ValueError('modelDirs', 'model directories must be absolute paths')
  }
  if (c.activeEngineId && !c.engines.some((e) => e.id === c.activeEngineId)) {
    throw new ValueError('activeEngineId', 'unknown engine id')
  }
}

function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p)
}

export function findEngine(engines: Engine[], id: string): Engine | undefined {
  return engines.find((e) => e.id === id)
}
