// Gateway: /v1/* OpenAI-compatible pass-through + Anthropic translation (spec 06).
import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Deps } from '../deps'
import { mapToOpenAI, mapFromOpenAI, streamToAnthropic, type AnthropicRequest } from './anthropic'

export function registerGateway(app: Hono, d: Deps): void {
  // ── POST /v1/messages — Anthropic translation (spec 06 §2) ───────────────

  app.post('/v1/messages', async (c) => {
    const target = d.manager.target()
    if (!target) {
      return c.json(
        { type: 'error', error: { type: 'api_error', message: 'No model loaded. Load one in TurboLLM.' } },
        503,
      )
    }

    let req: AnthropicRequest
    try {
      req = (await c.req.json()) as AnthropicRequest
    } catch {
      return c.json(
        { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid JSON body.' } },
        400,
      )
    }
    if (!req.max_tokens) {
      return c.json(
        { type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens is required.' } },
        400,
      )
    }

    d.manager.touch()
    const status = d.manager.status()
    const modelName = status.state === 'running' ? (status.model?.name ?? req.model ?? 'local') : (req.model ?? 'local')
    const oaiBody = mapToOpenAI(req)

    const res = await fetch(`${target}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(oaiBody),
    })

    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      return c.json(
        { type: 'error', error: { type: 'api_error', message: text || 'Engine error.' } },
        500,
      )
    }

    if (req.stream) {
      const msgId = `msg_${randomUUID().replace(/-/g, '')}`
      // Record session stats (B4) from the final usage the generator observes.
      // Fail-safe: the callback is only invoked best-effort and swallows nothing
      // that affects the client stream.
      const gen = streamToAnthropic(res.body, modelName, msgId, (u) => {
        try {
          d.manager.recordCompletion({ inputTokens: u.inputTokens, outputTokens: u.outputTokens })
        } catch { /* swallow — stats are best-effort */ }
      })
      // streamSSE flushes each chunk immediately through Node.js's HTTP layer.
      // Raw ReadableStream does not — chunks buffer until the response completes,
      // which makes Claude CLI (and any Anthropic-protocol client) appear "slow".
      return streamSSE(c, async (stream) => {
        for await (const evt of gen) {
          await stream.writeSSE({ event: evt.event, data: evt.data })
        }
      })
    }

    const oaiRes = (await res.json()) as Record<string, unknown>
    recordOpenAiUsage(d, oaiRes) // session stats (B4), fail-safe
    return c.json(mapFromOpenAI(oaiRes, modelName))
  })

  // ── POST /v1/messages/count_tokens (spec 06 §2) ───────────────────────────

  app.post('/v1/messages/count_tokens', async (c) => {
    let req: AnthropicRequest
    try {
      req = (await c.req.json()) as AnthropicRequest
    } catch {
      req = { messages: [] }
    }

    const target = d.manager.target()
    const oaiBody = mapToOpenAI(req)
    const promptText = ((oaiBody.messages as Array<Record<string, unknown>>) ?? [])
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n')
    const estimate = Math.ceil(promptText.length / 3.5)

    if (target) {
      try {
        const r = await fetch(`${target}/tokenize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: promptText }),
          signal: AbortSignal.timeout(5000),
        })
        if (r.ok) {
          const data = (await r.json()) as { tokens?: number[] }
          return c.json({ input_tokens: data.tokens?.length ?? estimate })
        }
      } catch {
        // fall through to estimate
      }
    }

    return c.json({ input_tokens: estimate })
  })

  // ── /v1/* OpenAI pass-through (spec 06 §1) ────────────────────────────────

  app.all('/v1/*', async (c) => {
    const target = d.manager.target()
    if (!target) {
      if (c.req.method === 'GET' && c.req.path === '/v1/models') {
        return c.json({ object: 'list', data: [] })
      }
      return c.json(
        {
          error: {
            message: 'No model loaded. Load one in TurboLLM.',
            type: 'model_not_loaded',
            code: 'model_not_loaded',
          },
        },
        503,
      )
    }
    d.manager.touch()

    const url = new URL(c.req.url)
    const upstream = target + url.pathname + url.search
    const headers = new Headers(c.req.raw.headers)
    headers.delete('host')

    const init: RequestInit & { duplex?: 'half' } = { method: c.req.method, headers }
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      init.body = c.req.raw.body
      init.duplex = 'half'
    }

    const res = await fetch(upstream, init)

    // Best-effort session-stats recording (B4) for OpenAI chat completions, fully
    // fail-safe and non-intrusive: tee the body so the client still gets the exact
    // upstream stream/bytes unchanged while we sniff usage off the copy.
    if (res.ok && res.body && c.req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      try {
        const [a, b] = res.body.tee()
        void recordOpenAiStreamUsage(d, b)
        return new Response(a, { status: res.status, headers: res.headers })
      } catch {
        return new Response(res.body, { status: res.status, headers: res.headers })
      }
    }

    return new Response(res.body, { status: res.status, headers: res.headers })
  })
}

// ── session-stats recording helpers (B4) ────────────────────────────────────

/** Record usage from a non-streaming OpenAI completion. Fail-safe. */
function recordOpenAiUsage(d: Deps, oai: Record<string, unknown>): void {
  try {
    const usage = oai.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
    const timings = oai.timings as { prompt_per_second?: number; predicted_per_second?: number } | undefined
    d.manager.recordCompletion({
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
      promptTps: timings?.prompt_per_second,
      genTps: timings?.predicted_per_second,
    })
  } catch { /* swallow — stats are best-effort */ }
}

/** Drain a teed copy of a streaming OpenAI SSE body to record final usage (B4).
 *  Never touches the client-facing stream; all errors are swallowed. */
async function recordOpenAiStreamUsage(d: Deps, body: ReadableStream<Uint8Array>): Promise<void> {
  try {
    const reader = body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let promptTokens = 0
    let completionTokens = 0
    let promptTps = 0
    let genTps = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') continue
        let chunk: Record<string, unknown>
        try { chunk = JSON.parse(raw) as Record<string, unknown> } catch { continue }
        const usage = chunk.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined
        if (usage) {
          if (usage.prompt_tokens) promptTokens = usage.prompt_tokens
          if (usage.completion_tokens) completionTokens = usage.completion_tokens
        }
        const timings = chunk.timings as { prompt_per_second?: number; predicted_per_second?: number } | undefined
        if (timings) {
          if (timings.prompt_per_second) promptTps = timings.prompt_per_second
          if (timings.predicted_per_second) genTps = timings.predicted_per_second
        }
      }
    }
    d.manager.recordCompletion({ inputTokens: promptTokens, outputTokens: completionTokens, promptTps, genTps })
  } catch { /* swallow — stats are best-effort */ }
}
