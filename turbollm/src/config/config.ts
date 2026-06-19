// Config load/save/migrate (spec 01). Ports the verified Go implementation to
// TypeScript. Single-threaded event loop => config.update() is atomic per call,
// so no locking is needed. Unknown JSON fields ride along on `data` and are
// preserved across round-trips for free.
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
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
  /** When LAN-exposed, require an API key for non-loopback requests (spec 06 §5).
   *  Off = open/unauthenticated LAN access (no key needed). Default on. */
  requireApiKey: boolean
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
/** One persisted auto-tune result (spec 09 §1, 01 §4), keyed by modelKey in
 *  {@link Config.benchResults}. Survives restart so the model list/detail can show
 *  "N tok/s on your machine". Additive: absent in pre-bench configs (normalize seeds {}). */
export interface BenchResult {
  modelKey: string
  tps: number
  ttftMs: number
  vramMb: number | null
  params: { ctx: number; ngl: number; nCpuMoe: number; parallel: number; kvTypeK: string; flashAttn: string }
  ts: string
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
/** Web-search backend selection (F-020). */
export type SearchProvider = 'tavily' | 'kagi' | 'searxng'
export interface SearchConfig {
  provider: SearchProvider
  tavilyApiKey?: string
  kagiApiKey?: string
  searxngUrl?: string
}

/** Built-in tool configuration (v0.7.0). */
export interface ToolsConfig {
  /** Legacy Tavily key (pre-F-020). Migrated into `search.tavilyApiKey` on load; kept for read. */
  tavily?: { apiKey: string }
  /** Pluggable web-search provider config (F-020). */
  search?: SearchConfig
  /** When true (default), run_code emits a confirmation-required message instead of
   *  executing immediately, giving the user a chance to approve (F-019). */
  requireRunCodeConfirmation?: boolean
}

/** One MCP server the daemon manages as a tool provider (v0.7.0). */
export interface McpServer {
  id: string
  name: string
  transport: 'stdio' | 'sse'
  /** stdio only — command to spawn */
  command?: string
  /** stdio only — argv after command */
  args?: string[]
  /** stdio only — extra env vars for the child process */
  env?: Record<string, string>
  /** sse only — base URL of the MCP server */
  url?: string
  enabled: boolean
}

/** MCP host configuration (v0.7.0). */
export interface McpConfig {
  servers: McpServer[]
}

/** Gateway intelligence (v0.6.0): auto model-swap + keep-N pool. */
export interface Gateway {
  /** When true, gateway requests that include a `model` field auto-load the named
   *  model if it isn't already running. Default on. */
  autoSwap: boolean
  /** Maximum number of models to keep loaded simultaneously. Default 1 = pure
   *  swap (unload A, load B). Values 2–4 keep multiple models hot in a pool with
   *  LRU eviction. Capped at 4. */
  keepN: number
}

/** ComfyUI GPU-coordination (so the LLM engine and ComfyUI don't fight over VRAM).
 *  Push-based: a one-time-installed ComfyUI custom node calls TurboLLM the moment a
 *  render starts (TurboLLM unloads the model + blocks loads) and when the queue drains
 *  (TurboLLM reloads the model it unloaded). No polling — see {@link ComfyGuard}. */
export interface ComfyUI {
  enabled: boolean
  /** Absolute path to the ComfyUI `custom_nodes` dir the gate node was installed into
   *  (set by the in-app installer). Empty until installed — lets the UI show state. */
  gatePath: string
  /** ComfyUI's HTTP origin (e.g. `http://127.0.0.1:8188`). Used by the REVERSE gate to
   *  call ComfyUI's native `POST /free` so it drops its VRAM before TurboLLM loads a
   *  model. Empty disables the reverse direction (we can't reach ComfyUI). */
  url: string
  /** Reverse gate (F-011): when TurboLLM is about to load a model, first ask ComfyUI to
   *  free its VRAM. The symmetric counterpart of the forward (acquire/release) gate —
   *  whoever the user is actively driving wins the GPU. Off by default. */
  reverseGate: boolean
  /** Persist the llama-server KV prompt cache to disk before a ComfyUI-forced unload and
   *  restore it on reload, so a long prefix isn't re-prefilled. Opt-in; llama.cpp
   *  text-only. See slot-cache.ts. */
  cachePersist: boolean
}
/** Global model defaults (spec 05 §3): the base LoadProfile values applied when a
 *  model is first seen and has no saved per-model profile. Saved profiles and
 *  per-request overrides still take precedence; these only replace the built-in
 *  heuristics for the listed fields. */
export interface ModelDefaults {
  ctx: number
  ngl: number
  imageMaxTokens?: number
  /** Hard cap on tokens generated per response (0 = unlimited). Applied to in-app
   *  chat and clamped onto external gateway requests so nothing on this machine can
   *  exceed it. */
  maxTokens?: number
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
  /** The folder downloads/imports land in (spec 01 §3, ADR-035). When '' or not in
   *  modelDirs, the FIRST entry in modelDirs is the effective default. */
  primaryModelDir: string
  modelProfiles: Record<string, unknown>
  /** Persisted auto-tune results keyed by modelKey (spec 09 §1, 01 §4). Additive;
   *  absent in old configs → normalize seeds {}. Never throws on load. */
  benchResults: Record<string, BenchResult>
  lastLoaded: LastLoaded
  autoLoadOnStart: boolean
  hf: HF
  modelDefaults: ModelDefaults
  featuredOverrideUrl: string
  comfyui: ComfyUI
  gateway: Gateway
  tools: ToolsConfig
  mcp: McpConfig
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

/** Pre-0.x location: the platform config dir (`%APPDATA%`, `~/Library/Application
 *  Support`, `~/.config`). Kept only so {@link migrateLegacyDataDir} can move old
 *  state into the canonical `~/.turbollm` dir. */
function legacyDataDir(): string {
  const base =
    process.platform === 'win32'
      ? process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support')
        : process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'turbollm')
}

/** Canonical data directory: `~/.turbollm` on every OS (one stable, discoverable
 *  home for config, chats, engines, caches — same model as `~/.ollama`). All
 *  daemon state lives here; a `--config` override redirects it elsewhere. */
export function defaultDataDir(): string {
  return join(homedir(), '.turbollm')
}

export function defaultConfigPath(): string {
  return join(defaultDataDir(), 'config.json')
}

/** One-time move of pre-0.x state from the platform config dir into `~/.turbollm`,
 *  so existing config/engines/chats/caches survive the relocation. No-op once the
 *  new dir exists, when there's nothing to migrate, or when the two coincide.
 *  Call ONLY for the default location — never when `--config` overrides the path. */
export function migrateLegacyDataDir(): void {
  const next = defaultDataDir()
  const prev = legacyDataDir()
  if (prev === next || existsSync(next) || !existsSync(prev)) return
  try {
    mkdirSync(dirname(next), { recursive: true })
    renameSync(prev, next) // same volume (both under the home tree) → atomic
  } catch {
    // Cross-device or a locked file (e.g. an old daemon still holding the DB):
    // fall back to a recursive copy and leave the legacy dir in place.
    try {
      cpSync(prev, next, { recursive: true })
    } catch {
      /* leave legacy state where it is; a fresh default config will be written */
      return
    }
  }
  // Engine binPaths are absolute and may point into the old data dir (managed
  // llama.cpp builds live under <dataDir>/engines/…). Repoint them at the new
  // location so they don't dangle after the move.
  try {
    const cfgPath = join(next, 'config.json')
    if (!existsSync(cfgPath)) return
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8')) as { engines?: { binPath?: string }[] }
    let changed = false
    for (const e of cfg.engines ?? []) {
      if (typeof e.binPath === 'string' && e.binPath.startsWith(prev)) {
        e.binPath = next + e.binPath.slice(prev.length)
        changed = true
      }
    }
    if (changed) writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  } catch {
    /* best effort — a dangling managed build is pruned at startup anyway */
  }
}

export function defaultConfig(): Config {
  return {
    version: SCHEMA_VERSION,
    daemon: {
      host: '127.0.0.1',
      port: 6996,
      lanBind: false,
      requireApiKey: true,
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
    primaryModelDir: '',
    modelProfiles: {},
    benchResults: {},
    lastLoaded: { modelKey: '', engineId: '' },
    autoLoadOnStart: false,
    hf: { token: '' },
    modelDefaults: { ctx: 8192, ngl: 99, imageMaxTokens: 0, maxTokens: 0 },
    featuredOverrideUrl: '',
    comfyui: { enabled: false, gatePath: '', url: '', reverseGate: false, cachePersist: false },
    gateway: { autoSwap: true, keepN: 1 },
    tools: {},
    mcp: { servers: [] },
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
  // Missing in pre-modelDefaults config files → fall back to the built-in defaults
  // (treat absent as defaults; never throw on an old file).
  c.modelDefaults = { ...d.modelDefaults, ...(c.modelDefaults ?? {}) }
  c.lastLoaded = { ...d.lastLoaded, ...(c.lastLoaded ?? {}) }
  c.apiKeys ??= []
  c.engines ??= []
  c.modelDirs ??= []
  // Primary model dir (spec 01 §3, ADR-035): absent in old files → '' (effective
  // default falls back to the first modelDir). Never throw on an old config.
  c.primaryModelDir ??= ''
  c.modelProfiles ??= {}
  // Persisted auto-tune results (spec 09 §1): absent in pre-bench configs → {}.
  c.benchResults ??= {}
  c.autoLoadOnStart ??= false
  c.featuredOverrideUrl ??= ''
  // ComfyUI coordination (absent in pre-comfyui configs → defaults; never throw on an
  // old file). Reseat only the known fields so the retired url/pollSeconds keys from
  // the earlier polling design don't linger on disk.
  const cu = (c.comfyui ?? {}) as Partial<ComfyUI>
  c.comfyui = {
    enabled: !!cu.enabled,
    gatePath: typeof cu.gatePath === 'string' ? cu.gatePath : '',
    // Reverse gate (F-011): ComfyUI origin + opt-in toggle. Absent in pre-F-011 configs
    // → '' / false. Reseated here (like the other known fields) so they aren't dropped.
    url: typeof cu.url === 'string' ? cu.url : '',
    reverseGate: !!cu.reverseGate,
    // KV prompt-cache persistence (F-014): opt-in. Absent in pre-F-014 configs → false.
    // Reseated like the other known fields so it isn't dropped on every load.
    cachePersist: !!cu.cachePersist,
  }
  // Gateway intelligence (v0.6.0): absent in pre-v0.6.0 configs → defaults; never throw.
  const gw = (c.gateway ?? {}) as Partial<Gateway>
  c.gateway = {
    autoSwap: gw.autoSwap !== false,
    keepN: typeof gw.keepN === 'number' && gw.keepN >= 1 ? Math.min(Math.floor(gw.keepN), 4) : 1,
  }
  // Built-in tools (v0.7.0): absent in pre-v0.7.0 configs → empty defaults.
  const tl = (c.tools ?? {}) as Partial<ToolsConfig>
  c.tools = {}
  if (tl.tavily && typeof tl.tavily.apiKey === 'string') {
    c.tools.tavily = { apiKey: tl.tavily.apiKey }
  }
  // Search provider (F-020): absent in pre-F-020 configs → default 'tavily', migrating any
  // legacy tavily.apiKey into search.tavilyApiKey so existing keys keep working.
  const sl = (tl.search ?? {}) as Partial<SearchConfig>
  const provider: SearchProvider =
    sl.provider === 'kagi' || sl.provider === 'searxng' ? sl.provider : 'tavily'
  c.tools.search = {
    provider,
    tavilyApiKey: sl.tavilyApiKey ?? c.tools.tavily?.apiKey ?? undefined,
    kagiApiKey: sl.kagiApiKey ?? undefined,
    searxngUrl: typeof sl.searxngUrl === 'string' && sl.searxngUrl.trim() ? sl.searxngUrl.trim() : undefined,
  }
  // requireRunCodeConfirmation (F-019): absent in pre-F-019 configs → true (safe default).
  c.tools.requireRunCodeConfirmation = tl.requireRunCodeConfirmation !== false
  // MCP host (v0.7.0): absent in pre-v0.7.0 configs → empty server list.
  const mc = (c.mcp ?? {}) as Partial<McpConfig>
  c.mcp = {
    servers: Array.isArray(mc.servers)
      ? mc.servers.filter((s): s is McpServer =>
          typeof s === 'object' && s !== null &&
          typeof s.id === 'string' && typeof s.name === 'string' &&
          (s.transport === 'stdio' || s.transport === 'sse'))
      : [],
  }
  // Telemetry level (spec 09 §3): the UI exposes 'off' | 'anon' | 'full'. Migrate
  // legacy/unknown values safely → 'off' (the conservative, opt-in default).
  c.telemetry.level = normalizeTelemetryLevel(c.telemetry.level)
  for (const e of c.engines) {
    e.capabilities ??= { kvTypes: [], flags: [] }
    e.capabilities.kvTypes ??= []
    e.capabilities.flags ??= []
  }
  if (c.activeEngineId && !c.engines.some((e) => e.id === c.activeEngineId)) c.activeEngineId = ''
  if (!c.activeEngineId && c.engines.length > 0) c.activeEngineId = c.engines[0].id
  // A primary that no longer exists in modelDirs (folder removed/renamed) falls
  // back to the effective default (first dir) — reset rather than throw.
  if (c.primaryModelDir && !c.modelDirs.includes(c.primaryModelDir)) c.primaryModelDir = ''
  c.version = SCHEMA_VERSION
}

/** Telemetry consent levels exposed in the UI (spec 09 §3). The stored config may
 *  additionally hold the first-run sentinel 'unset' (drives the consent modal); it
 *  is preserved on disk but maps to 'off' when surfaced as a settings enum value. */
export type TelemetryLevel = 'off' | 'anon' | 'full'

/** Coerce a stored telemetry level to a known value. Preserves the first-run
 *  sentinel 'unset'; migrates the legacy 'benchmarks' label → 'anon'; anything
 *  unrecognized → 'off'. Never throws (fail-safe on old/garbage config). */
function normalizeTelemetryLevel(level: unknown): string {
  if (level === 'unset' || level === 'off' || level === 'anon' || level === 'full') return level
  if (level === 'benchmarks' || level === 'anonymous') return 'anon' // legacy spec label
  return 'off'
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
  // ComfyUI reverse-gate origin (F-011): empty is allowed (reverse gate just stays off);
  // if set, it must be an http(s):// origin so the `POST {url}/free` call is well-formed.
  if (c.comfyui.url && !/^https?:\/\//i.test(c.comfyui.url)) {
    throw new ValueError('comfyui.url', 'must be an http(s):// origin (e.g. http://127.0.0.1:8188)')
  }
}

function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(p)
}

export function findEngine(engines: Engine[], id: string): Engine | undefined {
  return engines.find((e) => e.id === id)
}

/** Apply the global "max response tokens" cap. `limit <= 0` means unlimited (return
 *  the request's own value untouched). Otherwise return the smaller of the requested
 *  value and the limit; when the request set no value, fall back to the limit. */
export function clampMaxTokens(requested: number | null | undefined, limit: number): number | undefined {
  if (!Number.isFinite(limit) || limit <= 0) return requested ?? undefined
  if (requested == null || !Number.isFinite(requested) || requested <= 0) return limit
  return Math.min(requested, limit)
}
