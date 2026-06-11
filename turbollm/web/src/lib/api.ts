// Single typed API client. Every server interaction goes through here (spec 00 §4) —
// no inline fetch in components. Errors are normalized to ApiError carrying the
// daemon's error envelope { code, message } (spec 00 §3).

import type {
  ChatCompletionResponse,
  ChatMessage,
  Engine,
  EngineLogs,
  EnginesList,
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

// ── Engines registry (spec 02 §2) ────────────────────────────────────────────
export function listEngines(): Promise<EnginesList> {
  return request<EnginesList>('/api/v1/engines')
}

export function addEngine(input: { name: string; binPath: string }): Promise<Engine> {
  return request<Engine>('/api/v1/engines', { method: 'POST', json: input })
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
