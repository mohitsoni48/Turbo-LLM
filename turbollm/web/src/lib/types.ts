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

/** Default-engine provisioning progress (ADR-024), from GET /api/v1/status. */
export type EngineProvision = {
  active: boolean
  phase: 'idle' | 'downloading' | 'extracting' | 'error'
  backend: string
  pct: number // 0..1 while downloading; -1 = indeterminate (extracting)
  part?: number // 1-based current archive (multi-asset backends like CUDA)
  parts?: number // total archives for this backend
  error: string | null
}

/** Live running-session stats (B4), from GET /api/v1/status. Null unless the
 *  engine is running; resets each time the engine starts/stops. */
export type EngineStats = {
  requests: number
  inputTokens: number
  outputTokens: number
  avgPromptTps: number
  avgGenTps: number
  sinceMs: number
}

export type Status = {
  version: string
  engine: EngineRuntime
  model: LoadedModel | null
  engineStats?: EngineStats | null
  bench: { running: boolean; step?: number; total?: number; label?: string }
  downloads: { active: number }
  engineProvision?: EngineProvision
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

/** A selectable llama.cpp backend variant (ADR-025). A "build" of the official
 *  engine. `engineId` is the registered engine to activate once installed. */
export type BackendInfo = {
  id: string
  label: string
  installed: boolean
  recommended: boolean
  active: boolean
  engineId: string
}

export type MlxInfo = {
  supported: boolean
  installed: boolean
  active: boolean
  engineId: string
}

export type EngineBackends = {
  vendor: string
  recommended: string
  gpus: { name: string; vramMb: number; vendor: string }[]
  backends: BackendInfo[]
  mlx: MlxInfo
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
  format: 'gguf' | 'mlx'
  sizeBytes: number
  sizeLabel: string
  arch: string
  quant: string
  nativeCtx: number
  blockCount: number
  headCountKv: number
  moe: boolean
  expertCount: number
  /** >0 when the GGUF carries a built-in NextN multi-token-prediction head. */
  nextnLayers: number
  vision: boolean
  mmprojPath: string | null
  hasChatTemplate: boolean
  incomplete: boolean
  parseError: string | null
  loaded: boolean
  hasProfile: boolean
  benchTps: number | null
  /** Most-recent gen t/s recorded for this model in chat (spec 04 §5); null if
   *  never chatted with. */
  lastTps: number | null
  /** Live gen t/s for the currently-loaded model; null unless this model is loaded
   *  and a recent figure exists (best-effort until a full session accumulator lands). */
  liveTps: number | null
  mtime: string
}

export type ModelsList = {
  models: ModelEntry[]
  scanning: boolean
  lastScanAt: string
}

export type ModelDirs = {
  dirs: string[]
  /** The EFFECTIVE primary folder downloads/imports land in (spec 01 §3, ADR-035):
   *  the configured primary, or the first folder when unset. '' when no folders. */
  primaryDir: string
}

// ── Load profiles + VRAM fit (A4, spec 05) ───────────────────────────────────
export type Sampling = {
  temp: number
  topP: number
  topK: number
  minP: number
  repeatPenalty: number
  presencePenalty: number
}

export type LoadProfile = {
  ctx: number
  ngl: number
  nCpuMoe: number
  parallel: number
  kvUnified: boolean
  kvTypeK: string
  kvTypeV: string
  flashAttn: 'auto' | 'on' | 'off'
  threads: number
  threadsBatch: number
  useMmproj: boolean
  mmprojGpu: boolean
  imageMaxTokens: number
  cacheReuse: number
  useJinja: boolean
  chatTemplateFile: string
  speculative: 'off' | 'mtp' | 'nextn' | 'draft'
  mtpHeadPath: string
  draftModelPath: string
  sampling: Sampling
  extraArgs: string[]
  tunedBy?: string
}

export type FitVerdict = 'fits' | 'tight' | 'overflow' | 'cpu' | 'unknown'

export type VramFit = {
  estMb: number
  totalVramMb: number
  pct: number
  verdict: FitVerdict
}

export type SysGpu = { name: string; vramMb: number }

export type ModelDetail = ModelEntry & {
  profile: LoadProfile
  vramFit: VramFit
  gpu: SysGpu | null
  /** Logical CPU cores — drives the threads slider max + the "Auto" hint. */
  cores: number
}
