import { authHeaders, ApiError } from './api'
import type { AgentRun } from './agent-types'

export const agentRunKeys = {
  all: ['agent-runs'] as const,
  list: () => [...agentRunKeys.all, 'list'] as const,
  detail: (id: string) => [...agentRunKeys.all, 'detail', id] as const,
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...authHeaders(),
    ...((init?.headers as Record<string, string>) ?? {}),
  }
  const res = await fetch(path, { ...init, headers })
  if (res.status === 204) return undefined as T
  const text = await res.text()
  const data = text ? (JSON.parse(text) as unknown) : undefined
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

export async function fetchAgentRuns(): Promise<AgentRun[]> {
  return req<AgentRun[]>('/api/v1/agents/runs')
}

export async function fetchAgentRun(id: string): Promise<AgentRun> {
  return req<AgentRun>(`/api/v1/agents/runs/${id}`)
}

export async function createAgentRun(params: {
  title?: string
  systemPrompt?: string
  userMessage: string
  allowedTools?: string[]
}): Promise<AgentRun> {
  return req<AgentRun>('/api/v1/agents/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  })
}

export async function cancelAgentRun(id: string): Promise<void> {
  await req<{ ok: boolean }>(`/api/v1/agents/runs/${id}`, { method: 'DELETE' })
}

/** Async generator that replays buffered events from `fromSeq` then live-tails. */
export async function* subscribeRunStream(
  id: string,
  fromSeq = 0,
  signal?: AbortSignal,
): AsyncGenerator<{ event: string; data: unknown }> {
  const url = `/api/v1/agents/runs/${id}/stream?fromSeq=${fromSeq}`
  const res = await fetch(url, {
    headers: { Accept: 'text/event-stream', ...authHeaders() },
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`Stream error: ${res.status}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''

      let currentEvent = 'message'
      for (const line of lines) {
        if (line.startsWith('event: ')) { currentEvent = line.slice(7).trim(); continue }
        if (line.startsWith('data: ')) {
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') return
          try {
            const data = JSON.parse(raw) as unknown
            yield { event: currentEvent, data }
            if (currentEvent === 'done' || currentEvent === 'error') return
          } catch { /* ignore malformed */ }
          currentEvent = 'message'
        }
      }
    }
  } finally {
    reader.cancel()
  }
}
