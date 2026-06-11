// Shared TS types mirroring the Go daemon API JSON (spec 02). Keep these in sync
// with the daemon contract; the typed client in lib/api.ts returns these shapes.

export type EngineState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'

export type EngineError = {
  code: string
  message: string
  exitCode?: number
  logTail?: string[]
}

/** Active engine runtime state from GET /api/v1/status (spec 02 §1). */
export type EngineRuntime = {
  id: string
  name: string
  state: EngineState
  error?: EngineError
  port?: number
  pid?: number
}

/** Loaded model from GET /api/v1/status (null when none). */
export type LoadedModel = {
  key: string
  name: string
  quant: string
  ctx: number
  vision: boolean
  loadElapsedMs?: number
}

export type Status = {
  version: string
  engine: EngineRuntime
  model: LoadedModel | null
  bench: { running: boolean; step?: number; total?: number; label?: string }
  downloads: { active: number }
  telemetryLevel: string
  uptimeSec: number
}

/** A registered engine (GET /api/v1/engines, config §3 shape). */
export type EngineCapabilities = {
  kvTypes: string[]
  flags: string[]
}

export type Engine = {
  id: string
  name: string
  binPath: string
  kind?: string
  version: string
  capabilities: EngineCapabilities
  addedAt?: string
}

export type EnginesList = {
  engines: Engine[]
  activeEngineId: string
}

export type EngineLogs = {
  lines: string[]
}

/** Error envelope used for every non-2xx response (spec 00 §3). */
export type ApiErrorEnvelope = {
  error: { code: string; message: string }
}

// ── Chat (minimal, non-streaming — full chat is a later milestone) ───────────
export type ChatRole = 'user' | 'assistant' | 'system'

export type ChatMessage = {
  role: ChatRole
  content: string
}

export type ChatCompletionResponse = {
  choices?: { message?: { content?: string } }[]
}

// ── Models (discovery, spec 04) ──────────────────────────────────────────────
export type ModelEntry = {
  key: string
  name: string
  path: string
  dir: string
  sizeBytes: number
  sizeLabel: string
  arch: string
  quant: string
  nativeCtx: number
  blockCount: number
  moe: boolean
  expertCount: number
  vision: boolean
  mmprojPath: string | null
  hasChatTemplate: boolean
  incomplete: boolean
  parseError: string | null
  loaded: boolean
  hasProfile: boolean
  benchTps: number | null
  mtime: string
}

export type ModelsList = {
  models: ModelEntry[]
  scanning: boolean
  lastScanAt: string
}

export type ModelDirs = {
  dirs: string[]
}
