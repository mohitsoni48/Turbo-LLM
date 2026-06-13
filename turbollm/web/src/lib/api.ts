// Single typed API client. Every server interaction goes through here (spec 00 §4) —
// no inline fetch in components. Errors are normalized to ApiError carrying the
// daemon's error envelope { code, message } (spec 00 §3).

import type {
  ChatCompletionResponse,
  ChatMessage,
  Engine,
  EngineBackends,
  EngineLogs,
  EnginesList,
  LoadProfile,
  ModelDetail,
  ModelDirs,
  ModelsList,
  Status,
} from './types'

const AUTH_KEY = 'tllm.authToken'

/** Error thrown by the API client; preserves the daemon's machine-checkable code. */
export class ApiError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

function authHeader(): Record<string, string> {
  const token = localStorage.getItem(AUTH_KEY)
  return token ? { 'X-TurboLLM-Auth': token } : {}
}

async function request<T>(
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...authHeader(),
    ...((init?.headers as Record<string, string>) ?? {}),
  }
  let body = init?.body
  if (init && 'json' in init && init.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.json)
  }

  const res = await fetch(path, { ...init, headers, body })

  if (res.status === 204) return undefined as T

  const text = await res.text()
  const data = text ? safeJson(text) : undefined

  if (!res.ok) {
    const env = data as { error?: { code?: string; message?: string } } | undefined
    throw new ApiError(
      env?.error?.code ?? 'http_error',
      env?.error?.message ?? `Request failed with status ${res.status}.`,
      res.status,
    )
  }
  return data as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ── Status ───────────────────────────────────────────────────────────────────
export function getStatus(): Promise<Status> {
  return request<Status>('/api/v1/status')
}

/** Live running-session stats (B4) ride on the status payload — surfaced from the
 *  status poll rather than a separate endpoint. Re-exported for convenience. */
export type { EngineStats } from './types'

// ── Engines registry (spec 02 §2) ────────────────────────────────────────────
export function listEngines(): Promise<EnginesList> {
  return request<EnginesList>('/api/v1/engines')
}

/** Add succeeds with `warning: 'no_version'` (non-blocking) when the binary
 *  probed OK but no version string was found (spec 03 §2 `probe_no_version`). */
export type AddEngineResult = Engine & { warning: 'no_version' | null }

export function addEngine(input: { name: string; binPath: string }): Promise<AddEngineResult> {
  return request<AddEngineResult>('/api/v1/engines', { method: 'POST', json: input })
}

export function getEngineBackends(): Promise<EngineBackends> {
  return request<EngineBackends>('/api/v1/engines/backends')
}

export function installBackend(backend: string): Promise<{ accepted: true; backend: string }> {
  return request('/api/v1/engines/backends/install', { method: 'POST', json: { backend } })
}

export function installMlx(): Promise<{ accepted: true; engine: 'mlx' }> {
  return request('/api/v1/engines/mlx', { method: 'POST', json: {} })
}

export function cancelBackendDownload(): Promise<{ ok: boolean }> {
  return request('/api/v1/engines/backends/cancel', { method: 'POST', json: {} })
}

export function deleteEngineBackend(id: string): Promise<{ ok: true }> {
  return request(`/api/v1/engines/backends/${encodeURIComponent(id)}`, { method: 'DELETE', json: {} })
}

export function renameEngine(id: string, name: string): Promise<Engine> {
  return request<Engine>(`/api/v1/engines/${encodeURIComponent(id)}`, {
    method: 'PUT',
    json: { name },
  })
}

export function removeEngine(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/engines/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export function activateEngine(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(
    `/api/v1/engines/${encodeURIComponent(id)}/activate`,
    { method: 'POST' },
  )
}

export function reprobeEngine(id: string): Promise<Engine> {
  return request<Engine>(`/api/v1/engines/${encodeURIComponent(id)}/reprobe`, {
    method: 'POST',
  })
}

// ── Engine lifecycle (spec 02 §3) ────────────────────────────────────────────
export function startEngine(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/engine/start', { method: 'POST', json: {} })
}

export function stopEngine(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/engine/stop', { method: 'POST', json: {} })
}

export function restartEngine(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/engine/restart', { method: 'POST', json: {} })
}

// ── Engine logs ───────────────────────────────────────────────────────────────
export function getEngineLogs(tail = 200): Promise<EngineLogs> {
  return request<EngineLogs>(`/api/v1/engine/logs?tail=${tail}`)
}

/** URL for the SSE live log tail (consumed via EventSource). */
export const engineLogStreamUrl = '/api/v1/engine/logs/stream'

// ── Filesystem browser (spec 03 §9) ──────────────────────────────────────────
export interface FsEntry {
  name: string
  path: string
  isDir: boolean
}
export interface FsListing {
  path: string
  parent: string | null
  entries: FsEntry[]
}

/** List a directory under the daemon's home dir (loopback + home-confined,
 *  enforced server-side). Omit `path` to start at the home directory. */
export function browseFs(path?: string): Promise<FsListing> {
  const q = path ? `?path=${encodeURIComponent(path)}` : ''
  return request<FsListing>(`/api/v1/fs/browse${q}`)
}

// ── Models (discovery, spec 04) ──────────────────────────────────────────────
export function getModels(): Promise<ModelsList> {
  return request<ModelsList>('/api/v1/models')
}

export function rescanModels(): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/models/rescan', { method: 'POST', json: {} })
}

export function getModelDirs(): Promise<ModelDirs> {
  return request<ModelDirs>('/api/v1/modeldirs')
}

export function addModelDir(dir: string): Promise<ModelDirs> {
  return request<ModelDirs>('/api/v1/modeldirs', { method: 'POST', json: { dir } })
}

export function removeModelDir(dir: string): Promise<ModelDirs> {
  return request<ModelDirs>('/api/v1/modeldirs', { method: 'DELETE', json: { dir } })
}

/** Set the primary download/import folder (spec 01 §3, ADR-035). `dir` must be one
 *  of the configured model folders; returns the updated modeldirs payload. */
export function setPrimaryModelDir(dir: string): Promise<ModelDirs> {
  return request<ModelDirs>('/api/v1/modeldirs/primary', { method: 'POST', json: { dir } })
}

/** Delete a model's file(s) from disk (spec 05). Returns the removed paths; 409
 *  `model_loaded` if the model is currently loaded in the running engine. */
export function deleteModel(key: string): Promise<{ ok: true; deleted: string[] }> {
  return request<{ ok: true; deleted: string[] }>(`/api/v1/models/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  })
}

// ── Load profiles + load flow (A4, spec 05) ──────────────────────────────────
export function getModelDetail(key: string): Promise<ModelDetail> {
  return request<ModelDetail>(`/api/v1/models/${encodeURIComponent(key)}`)
}

export function saveModelProfile(key: string, profile: LoadProfile): Promise<LoadProfile> {
  return request<LoadProfile>(`/api/v1/models/${encodeURIComponent(key)}/profile`, {
    method: 'PUT',
    json: profile,
  })
}

export function resetModelProfile(key: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/models/${encodeURIComponent(key)}/profile/reset`, {
    method: 'POST',
    json: {},
  })
}

/** Load a model by key, optionally with one-off profile overrides (spec 05 §7). */
export function loadModel(modelKey: string, profileOverrides?: Partial<LoadProfile>): Promise<{ ok: true }> {
  return request<{ ok: true }>('/api/v1/engine/start', {
    method: 'POST',
    json: { modelKey, profileOverrides },
  })
}

// ── Settings (daemon config UI subset) ───────────────────────────────────────
/** Global model defaults (spec 05 §3): base load values applied to never-seen
 *  models that have no saved per-model profile. */
export type ModelDefaults = {
  ctx: number
  ngl: number
  imageMaxTokens?: number
}

/** Telemetry consent level (spec 09 §3): off | anonymous benchmarks | + crash. */
export type TelemetryLevel = 'off' | 'anon' | 'full'

export type DaemonSettings = {
  idleTtlMinutes: number
  theme: string
  autoGenerateTitles: boolean
  openBrowserOnStart: boolean
  autoLoadOnStart: boolean
  /** Expose the API on the local network (spec 08 §2). Auto-restart is deferred —
   *  changing this requires a daemon restart to take effect. */
  lanBind: boolean
  telemetryLevel: TelemetryLevel
  modelDefaults: ModelDefaults
}

export function getSettings(): Promise<DaemonSettings> {
  return request<DaemonSettings>('/api/v1/settings')
}

export function saveSettings(patch: Partial<DaemonSettings>): Promise<DaemonSettings> {
  return request<DaemonSettings>('/api/v1/settings', { method: 'PATCH', json: patch })
}

/** Representative example of exactly what a given telemetry level would send
 *  (spec 09 §4). Illustrative only — nothing is transmitted. `payload` is null for
 *  'off', else an array of example events. */
export type TelemetryPreview = {
  level: TelemetryLevel
  sends: boolean
  note: string
  payload: unknown
}

export function getTelemetryPreview(level: TelemetryLevel): Promise<TelemetryPreview> {
  return request<TelemetryPreview>(`/api/v1/telemetry/preview?level=${encodeURIComponent(level)}`)
}

/** LAN network info (spec 08 §2): expose state, the reachable LAN URL, and whether
 *  an API key exists (required for non-local access). */
export type NetworkInfo = {
  lanBind: boolean
  lanUrl: string
  hasApiKey: boolean
}

export function getNetworkInfo(): Promise<NetworkInfo> {
  return request<NetworkInfo>('/api/v1/settings/network')
}

// ── API keys (spec 06 §5) ────────────────────────────────────────────────────
export interface ApiKeyMeta {
  id: string
  name: string
  prefix: string
  createdAt: string
  lastUsedAt: string | null
}
export interface ApiKeyCreated { key: string; meta: ApiKeyMeta }
export interface ApiKeysList { keys: ApiKeyMeta[] }
export interface ConnectStep { label: string; snippet: string; lang: string }
export interface ConnectInfo { cli: string; title: string; steps: ConnectStep[] }

export function getApiKeys(): Promise<ApiKeysList> {
  return request<ApiKeysList>('/api/v1/keys')
}
export function createApiKey(name: string): Promise<ApiKeyCreated> {
  return request<ApiKeyCreated>('/api/v1/keys', { method: 'POST', json: { name } })
}
export function deleteApiKey(id: string): Promise<{ ok: true }> {
  return request<{ ok: true }>(`/api/v1/keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
export function getConnect(cli: string): Promise<ConnectInfo> {
  return request<ConnectInfo>(`/api/v1/connect/${encodeURIComponent(cli)}`)
}

// ── System info (spec 05 §6) ─────────────────────────────────────────────────
export interface SysInfo {
  os: string
  cpu: string
  cores: number
  ramMB: number
  gpus: Array<{ name: string; vramMb: number; vendor: string }>
}

export function getSysInfo(): Promise<SysInfo> {
  return request<SysInfo>('/api/v1/sysinfo')
}

// ── Chat (non-streaming gateway passthrough) ─────────────────────────────────
export function chatCompletion(input: {
  model: string
  messages: ChatMessage[]
}): Promise<ChatCompletionResponse> {
  return request<ChatCompletionResponse>('/v1/chat/completions', {
    method: 'POST',
    json: { model: input.model, messages: input.messages, stream: false },
  })
}
