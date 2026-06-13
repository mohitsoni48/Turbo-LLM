// Chat API routes (spec 07). Conversations CRUD + SSE streaming send + message actions.
import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Deps } from '../deps'
import { getSysInfo } from '../sysinfo/sysinfo'
import type { MessageStats } from './db'

// Track in-flight abort controllers per conversation id.
const inflight = new Map<string, AbortController>()

// Built-in system prompt for the TurboLLM Expert thread (spec 08 §2). Kept
// server-side and never sent to the client, so it stays hidden from the UI.
const EXPERT_SYSTEM_PROMPT = `You are the TurboLLM in-app expert assistant — a knowledgeable, friendly guide built into TurboLLM, a local-first desktop app for running large language models on the user's own machine.

Your job is to help the user get the most out of TurboLLM:
- Explain what TurboLLM features do and how to use them: chatting with local models, the Models screen (discover, download, load, and tune models), the Engines screen (install and manage inference backends like llama.cpp), and Settings (idle timeout, model defaults such as context length and GPU layers, auto-load, theme, network/LAN exposure, and privacy/telemetry).
- Help the user configure things: picking and loading a model, adjusting sampling (temperature, top-p, top-k, min-p), setting context length and GPU offload, and managing per-thread system prompts and sampling overrides.
- Troubleshoot common problems: a model that won't load, slow generation, running out of context, missing or failed engine installs, and GPU/CPU offload questions. Reason from the symptoms the user describes and the hardware they mention.

Guidelines:
- Keep answers practical, concise, and actionable. Prefer concrete steps ("Open the Models screen, click …") over abstract advice.
- When something depends on the user's hardware or which model is loaded, say so and ask a brief clarifying question if needed.
- Everything runs locally and offline; never suggest sending the user's data to external services.
- If you are unsure or a feature may not exist, say so honestly rather than inventing details.`

function buildExpertPrompt(): string {
  const sys = getSysInfo()
  const ramGb = Math.round(sys.ramMB / 1024)
  const gpuLines = sys.gpus.length
    ? sys.gpus.map((g) => `- GPU: ${g.name}${g.vramMb ? ` (${Math.round(g.vramMb / 1024)} GB VRAM)` : ''}`).join('\n')
    : '- GPU: none detected'
  const hw = [
    '\n\n## User\'s hardware',
    `- CPU: ${sys.cpu}${sys.cores ? ` (${sys.cores} cores)` : ''}`,
    `- RAM: ${ramGb} GB`,
    gpuLines,
  ].join('\n')
  return EXPERT_SYSTEM_PROMPT + hw
}

type S = 200 | 201 | 202 | 400 | 404 | 409 | 500
function err(c: Context, s: S, code: string, msg: string) { return c.json({ error: { code, message: msg } }, s) }
async function body<T>(c: Context): Promise<T> { try { return await c.req.json() as T } catch { return {} as T } }

export function registerChatRoutes(app: Hono, d: Deps): void {
  const { db } = d

  // ── conversations CRUD ─────────────────────────────────────────────────────

  app.get('/api/v1/conversations', (c) => {
    const q = c.req.query('q')
    return c.json({ conversations: db.listConversations(q) })
  })

  app.post('/api/v1/conversations', async (c) => {
    const b = await body<{ title?: string; systemPrompt?: string; modelKey?: string }>(c)
    const conv = db.createConversation({ title: b.title, systemPrompt: b.systemPrompt, modelKey: b.modelKey })
    return c.json(conv, 201)
  })

  // Launch the built-in TurboLLM Expert thread (spec 08 §2). The system prompt is
  // injected server-side and the conversation is flagged expertMode so the client
  // never sees or edits it.
  app.post('/api/v1/conversations/expert', async (c) => {
    const ms = d.manager.status()
    const conv = db.createConversation({
      title: 'TurboLLM Expert',
      systemPrompt: buildExpertPrompt(),
      modelKey: ms.model?.key ?? '',
      expertMode: true,
    })
    return c.json(conv, 201)
  })

  app.get('/api/v1/conversations/:id', (c) => {
    const conv = db.getConversation(c.req.param('id'), true)
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')
    return c.json(conv)
  })

  app.patch('/api/v1/conversations/:id', async (c) => {
    const b = await body<{ title?: string; systemPrompt?: string; sampling?: Record<string, number> }>(c)
    const ok = db.updateConversation(c.req.param('id'), b)
    if (!ok) return err(c, 404, 'not_found', 'Conversation not found.')
    return c.json(db.getConversation(c.req.param('id'))!)
  })

  app.delete('/api/v1/conversations/:id', (c) => {
    const ok = db.deleteConversation(c.req.param('id'))
    if (!ok) return err(c, 404, 'not_found', 'Conversation not found.')
    return c.json({ ok: true })
  })

  // ── streaming send (spec 07 §2) ────────────────────────────────────────────

  app.post('/api/v1/conversations/:id/messages', async (c) => {
    const convId = c.req.param('id')
    const b = await body<{ content?: string; images?: string[]; docContext?: string; textAttachments?: string[]; disableThinking?: boolean }>(c)
    const content = (b.content ?? '').trim()
    if (!content) return err(c, 400, 'invalid_input', 'content is required.')

    const conv = db.getConversation(convId, true)
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')

    const ms = d.manager.status()
    if (ms.state !== 'running' || !ms.model) return err(c, 409, 'model_not_loaded', 'Load a model first.')
    const target = d.manager.target()
    if (!target) return err(c, 409, 'model_not_loaded', 'Engine not running.')

    if (inflight.has(convId)) return err(c, 409, 'generation_in_flight', 'A generation is already running for this conversation.')

    const images = b.images ?? []
    const textAttachments = b.textAttachments ?? []

    // Persist user message — only the typed text is stored as content; images are
    // kept in attachments (the full doc context is folded into the engine prompt below).
    const userMsg = db.addMessage(convId, 'user', content, { attachments: images, textAttachments })

    // Create a placeholder assistant message
    db.addMessage(convId, 'assistant', '', { stats: { aborted: false } })
    const assistantMsg = db.getLastMessage(convId)!

    const ac = new AbortController()
    inflight.set(convId, ac)

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => { ac.abort(); inflight.delete(convId) })

      // Emit meta event
      await stream.writeSSE({ event: 'meta', data: JSON.stringify({ userMessageId: userMsg.id, assistantMessageId: assistantMsg.id }) })

      // Build messages array for engine
      const allMsgs = (conv.messages ?? []).filter(m => m.id !== assistantMsg.id)
      const engineMessages: { role: string; content: unknown }[] = []
      if (conv.systemPrompt) engineMessages.push({ role: 'system', content: conv.systemPrompt })
      for (const m of allMsgs) {
        engineMessages.push({ role: m.role, content: m.content })
      }
      // Fold any attached document text into the prompt; attach images as multimodal parts.
      const fullContent = b.docContext ? `${b.docContext}\n\n${content}` : content
      const userContent: unknown = images.length
        ? [{ type: 'text', text: fullContent }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
        : fullContent
      engineMessages.push({ role: 'user', content: userContent })

      await runGeneration(d, stream, { convId, conv, engineMessages, assistantMsg, ms, target, ac, disableThinking: b.disableThinking ?? false })
    })
  })

  // ── continue (regenerate last assistant response for the existing last user
  //    message, WITHOUT adding a new user message) ──────────────────────────────

  app.post('/api/v1/conversations/:id/continue', async (c) => {
    const convId = c.req.param('id')
    const b = await body<{ disableThinking?: boolean }>(c)

    const conv = db.getConversation(convId, true)
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')

    const ms = d.manager.status()
    if (ms.state !== 'running' || !ms.model) return err(c, 409, 'model_not_loaded', 'Load a model first.')
    const target = d.manager.target()
    if (!target) return err(c, 409, 'model_not_loaded', 'Engine not running.')

    if (inflight.has(convId)) return err(c, 409, 'generation_in_flight', 'A generation is already running for this conversation.')

    const lastUser = (conv.messages ?? []).filter((m) => m.role === 'user').at(-1)
    if (!lastUser) return err(c, 400, 'no_user_message', 'No user message to respond to.')

    // Create a placeholder assistant message
    db.addMessage(convId, 'assistant', '', { stats: { aborted: false } })
    const assistantMsg = db.getLastMessage(convId)!

    const ac = new AbortController()
    inflight.set(convId, ac)

    return streamSSE(c, async (stream) => {
      stream.onAbort(() => { ac.abort(); inflight.delete(convId) })

      // Emit meta event (no new user message — reuse the existing last user message id)
      await stream.writeSSE({ event: 'meta', data: JSON.stringify({ userMessageId: lastUser.id, assistantMessageId: assistantMsg.id }) })

      // Build messages array for engine from the existing (already-trimmed) history.
      const allMsgs = (conv.messages ?? []).filter((m) => m.id !== assistantMsg.id)
      const engineMessages: { role: string; content: unknown }[] = []
      if (conv.systemPrompt) engineMessages.push({ role: 'system', content: conv.systemPrompt })
      for (const m of allMsgs) {
        engineMessages.push({ role: m.role, content: m.content })
      }

      await runGeneration(d, stream, { convId, conv, engineMessages, assistantMsg, ms, target, ac, disableThinking: b.disableThinking ?? false })
    })
  })

  // ── stop (spec 07 §2) ──────────────────────────────────────────────────────

  app.post('/api/v1/chat/stop', async (c) => {
    const b = await body<{ conversationId?: string }>(c)
    const convId = b.conversationId
    if (!convId) return err(c, 400, 'invalid_input', 'conversationId required.')
    const ac = inflight.get(convId)
    if (ac) ac.abort()
    return c.json({ ok: true })
  })

  // ── message actions B2 ─────────────────────────────────────────────────────

  app.put('/api/v1/conversations/:id/messages/:msgId', async (c) => {
    const { id: convId, msgId } = c.req.param()
    const b = await body<{ content?: string }>(c)
    if (!b.content?.trim()) return err(c, 400, 'invalid_input', 'content required.')
    const msg = db.getMessage(msgId)
    if (!msg || msg.convId !== convId) return err(c, 404, 'not_found', 'Message not found.')
    if (msg.role !== 'user') return err(c, 400, 'invalid_input', 'Can only edit user messages.')
    if (inflight.has(convId)) return err(c, 409, 'generation_in_flight', 'Stop generation first.')
    db.updateMessage(msgId, { content: b.content.trim() })
    db.deleteMessagesAfterSeq(convId, msg.seq)
    return c.json({ messages: db.getMessages(convId) })
  })

  app.delete('/api/v1/conversations/:id/messages/:msgId', (c) => {
    const { id: convId, msgId } = c.req.param()
    const msg = db.getMessage(msgId)
    if (!msg || msg.convId !== convId) return err(c, 404, 'not_found', 'Message not found.')
    db.deleteMessage(msgId)
    return c.json({ ok: true })
  })

  app.post('/api/v1/conversations/:id/regenerate', (c) => {
    const convId = c.req.param('id')
    if (inflight.has(convId)) return err(c, 409, 'generation_in_flight', 'Stop generation first.')
    const last = db.getLastMessage(convId)
    if (last?.role === 'assistant') db.deleteMessage(last.id)
    return c.json({ ok: true })
  })
}

// ── shared generation streaming ───────────────────────────────────────────────

type StreamHandle = Parameters<Parameters<typeof streamSSE>[1]>[0]
type ManagerStatus = ReturnType<Deps['manager']['status']>

interface GenerationCtx {
  convId: string
  conv: NonNullable<ReturnType<Deps['db']['getConversation']>>
  engineMessages: { role: string; content: unknown }[]
  assistantMsg: NonNullable<ReturnType<Deps['db']['getLastMessage']>>
  ms: ManagerStatus
  target: string
  ac: AbortController
  /** When true, instruct the engine to skip reasoning entirely (model answers
   *  directly). Mirrors the params autoTitle uses. */
  disableThinking: boolean
}

/**
 * Streams a single assistant completion: posts to the engine, relays delta/reasoning/
 * progress SSE events, parses inline <think> tags, persists the final message + stats,
 * and fires auto-title. Shared by the messages and continue endpoints.
 */
async function runGeneration(d: Deps, stream: StreamHandle, ctx: GenerationCtx): Promise<void> {
  const { db } = d
  const { convId, conv, engineMessages, assistantMsg, ms, target, ac, disableThinking } = ctx

      // Merge sampling: model profile sampling ⊕ conversation overrides
      const modelSampling: Record<string, number> = {}
      const convSampling = conv.sampling ?? {}
      const merged = { ...modelSampling, ...convSampling }

      const reqBody: Record<string, unknown> = {
        model: ms.model!.key,
        messages: engineMessages,
        stream: true,
        stream_options: { include_usage: true },
        return_progress: true,
        ...merged,
      }
      // Disable thinking at the engine level when requested: the model answers
      // directly with no reasoning pass. `reasoning_budget: 0` covers llama-server's
      // native reasoning control; `enable_thinking: false` covers Qwen-style chat
      // templates. Both are no-ops on engines/models that don't reason (same pair
      // autoTitle relies on).
      if (disableThinking) {
        reqBody.reasoning_budget = 0
        reqBody.chat_template_kwargs = { enable_thinking: false }
      }

      const requestStart = Date.now()
      let ttftMs = 0
      let firstDelta = false
      let thinkStart = 0
      let thinkEnd = 0
      let fullContent = ''
      let fullReasoning = ''
      let inThink = false
      let pendingThinkBuf = ''
      let finalUsage: {
        prompt_tokens?: number
        completion_tokens?: number
        prompt_tokens_details?: { cached_tokens?: number }
      } = {}
      let finalTimings: Record<string, number> = {}
      let aborted = false
      let liveOut = 0 // approximate output-token count for the live engine-card row

      // Mark this completion as in-flight so the engine card's live "Generating…"
      // indicator (and the idle watchdog) can see it. Paired with generationEnd in
      // the finally below so a thrown/aborted stream can never leak the counter.
      d.manager.generationStart()
      try {
        const res = await fetch(`${target}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
          signal: ac.signal,
          duplex: 'half',
        })

        if (!res.ok || !res.body) {
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'engine_error', message: `Engine returned ${res.status}` }) })
          return
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''

        outer: while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue
            const raw = line.slice(6).trim()
            if (raw === '[DONE]') break outer

            let chunk: Record<string, unknown>
            try { chunk = JSON.parse(raw) as Record<string, unknown> } catch { continue }

            // Prompt progress
            const pp = chunk.prompt_progress as { processed?: number; total?: number; tps?: number } | undefined
            if (pp && pp.total) {
              const pct = Math.round((pp.processed ?? 0) / pp.total * 100)
              d.manager.setLiveGen({ phase: 'prompt', pct, outputTokens: 0 })
              await stream.writeSSE({ event: 'progress', data: JSON.stringify({ phase: 'prompt', processed: pp.processed, total: pp.total, pct, tps: pp.tps ?? 0 }) })
              continue
            }

            // Usage / timings (may appear on a final empty delta chunk)
            if (chunk.usage) finalUsage = chunk.usage as typeof finalUsage
            if (chunk.timings) finalTimings = chunk.timings as typeof finalTimings

            const choices = chunk.choices as Array<{ delta?: { content?: string; reasoning_content?: string }; finish_reason?: string }> | undefined
            if (!choices?.length) continue
            const delta = choices[0].delta ?? {}

            // Reasoning content (explicit field — newer llama-server with reasoning model)
            if (delta.reasoning_content) {
              const rc = delta.reasoning_content
              if (!thinkStart) thinkStart = Date.now()
              thinkEnd = Date.now()
              fullReasoning += rc
              await stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ delta: rc }) })
              continue
            }

            const raw_content = delta.content ?? ''
            if (!raw_content) continue

            // Detect <think>...</think> tags inline (older llama-server with --jinja)
            let toProcess = raw_content
            while (toProcess.length > 0) {
              if (!inThink && !firstDelta) {
                // Haven't seen any real content yet — might start with <think>
                pendingThinkBuf += toProcess
                const openIdx = pendingThinkBuf.indexOf('<think>')
                if (openIdx === 0) {
                  inThink = true
                  if (!thinkStart) thinkStart = Date.now()
                  pendingThinkBuf = pendingThinkBuf.slice(7)
                  toProcess = ''
                } else if (openIdx > 0) {
                  // Content before <think>
                  const before = pendingThinkBuf.slice(0, openIdx)
                  fullContent += before
                  firstDelta = true
                  if (!ttftMs) { ttftMs = Date.now() - requestStart; firstDelta = true }
                  await stream.writeSSE({ event: 'delta', data: JSON.stringify({ delta: before }) })
                  inThink = true
                  if (!thinkStart) thinkStart = Date.now()
                  pendingThinkBuf = pendingThinkBuf.slice(openIdx + 7)
                  toProcess = ''
                } else if (pendingThinkBuf.length > 20) {
                  // No <think> tag coming — flush as content
                  const flush = pendingThinkBuf
                  pendingThinkBuf = ''
                  fullContent += flush
                  firstDelta = true
                  if (!ttftMs) ttftMs = Date.now() - requestStart
                  await stream.writeSSE({ event: 'delta', data: JSON.stringify({ delta: flush }) })
                  toProcess = ''
                } else {
                  toProcess = ''
                }
              } else if (inThink) {
                pendingThinkBuf += toProcess
                const closeIdx = pendingThinkBuf.indexOf('</think>')
                if (closeIdx >= 0) {
                  const thinkChunk = pendingThinkBuf.slice(0, closeIdx)
                  if (thinkChunk) {
                    thinkEnd = Date.now()
                    fullReasoning += thinkChunk
                    await stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ delta: thinkChunk }) })
                  }
                  inThink = false
                  thinkEnd = Date.now()
                  pendingThinkBuf = pendingThinkBuf.slice(closeIdx + 8)
                  toProcess = ''
                  // Remaining after </think> will be emitted as content next iteration
                  if (pendingThinkBuf) {
                    fullContent += pendingThinkBuf
                    firstDelta = true
                    if (!ttftMs) ttftMs = Date.now() - requestStart
                    await stream.writeSSE({ event: 'delta', data: JSON.stringify({ delta: pendingThinkBuf }) })
                    pendingThinkBuf = ''
                  }
                } else {
                  thinkEnd = Date.now()
                  fullReasoning += pendingThinkBuf
                  await stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ delta: pendingThinkBuf }) })
                  pendingThinkBuf = ''
                  toProcess = ''
                }
              } else {
                // Normal content
                if (!ttftMs) ttftMs = Date.now() - requestStart
                firstDelta = true
                fullContent += toProcess
                // Each llama-server content chunk is ~one token — a good-enough live count.
                d.manager.setLiveGen({ phase: 'gen', pct: 0, outputTokens: ++liveOut })
                await stream.writeSSE({ event: 'delta', data: JSON.stringify({ delta: toProcess }) })
                toProcess = ''
              }
            }
          }
        }

        // Flush any pending think buf as reasoning if we're still in think at end
        if (pendingThinkBuf && inThink) {
          fullReasoning += pendingThinkBuf
          await stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ delta: pendingThinkBuf }) })
        } else if (pendingThinkBuf) {
          fullContent += pendingThinkBuf
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ delta: pendingThinkBuf }) })
        }

      } catch (e: unknown) {
        const isAbort = (e as Error)?.name === 'AbortError'
        aborted = isAbort
        if (!isAbort) {
          await stream.writeSSE({ event: 'error', data: JSON.stringify({ code: 'engine_stopped', message: (e as Error).message }) })
        }
      } finally {
        d.manager.generationEnd()
        inflight.delete(convId)
      }

      const totalMs = Date.now() - requestStart
      const thinkMs = thinkStart && thinkEnd ? thinkEnd - thinkStart : 0
      const ctxMax = ms.model?.ctx ?? 4096

      // Build stats: prefer engine-reported timings, fall back to wall-clock
      const stats: Partial<MessageStats> = {
        ttftMs,
        totalMs,
        thinkMs,
        ctxUsed: (finalUsage.prompt_tokens ?? 0) + (finalUsage.completion_tokens ?? 0),
        ctxMax,
        model: ms.model?.name ?? '',
        aborted,
      }
      // cached prompt tokens: prefer the engine's explicit count, else infer it
      // as (full prompt − tokens it actually had to process).
      const fullPrompt = finalUsage.prompt_tokens ?? 0
      const cachedExplicit = finalUsage.prompt_tokens_details?.cached_tokens
      if (finalTimings.prompt_n) {
        const processed = finalTimings.prompt_n
        stats.promptTokens = fullPrompt || processed
        stats.promptMs     = finalTimings.prompt_ms
        stats.promptTps    = finalTimings.prompt_per_second
        stats.genTokens    = finalTimings.predicted_n
        stats.genMs        = finalTimings.predicted_ms
        stats.tps          = finalTimings.predicted_per_second
        stats.cachedTokens = cachedExplicit ?? Math.max(0, (fullPrompt || processed) - processed)
      } else {
        // Fallback: wall clock
        stats.promptTokens = fullPrompt
        stats.genTokens    = finalUsage.completion_tokens ?? 0
        stats.genMs        = totalMs - ttftMs
        stats.tps          = stats.genMs > 0 ? Math.round((stats.genTokens / stats.genMs) * 1000 * 10) / 10 : 0
        stats.cachedTokens = cachedExplicit ?? 0
      }

      // Persist final assistant message
      db.updateMessage(assistantMsg.id, { content: fullContent, reasoning: fullReasoning, stats })
      db.touchConversation(convId)

      // Feed the running-session stats accumulator (B4). Fail-safe: a recording
      // error must never affect the completion response.
      try {
        d.manager.recordCompletion({
          inputTokens: stats.promptTokens,
          outputTokens: stats.genTokens,
          promptTps: stats.promptTps,
          genTps: stats.tps,
        })
      } catch { /* swallow — stats are best-effort */ }

      const finalMsg = db.getMessage(assistantMsg.id)!
      await stream.writeSSE({ event: 'done', data: JSON.stringify({ message: finalMsg }) })

      // Auto-title: fire 1s after first completed exchange (spec 07 §6)
      if (!aborted && conv.title === 'New chat' && d.store.snapshot().daemon.autoGenerateTitles) {
        setTimeout(() => { void autoTitle(d, convId, engineMessages, fullContent, target) }, 1000)
      }
}

// ── auto title generation ──────────────────────────────────────────────────

async function autoTitle(
  d: Deps,
  convId: string,
  prevMessages: { role: string; content: unknown }[],
  assistantReply: string,
  target: string,
): Promise<void> {
  try {
    const ms = d.manager.status()
    if (ms.state !== 'running') return
    const titleMessages = [
      ...prevMessages.slice(-2),
      { role: 'assistant', content: assistantReply.slice(0, 500) },
      {
        role: 'user',
        // /no_think disables thinking on Qwen-style templates; chat_template_kwargs
        // below covers the rest; any leaked <think> is stripped from the output.
        content: 'Generate a concise 3-6 word title for this conversation. Reply with ONLY the title — no quotes, no punctuation, no preamble. /no_think',
      },
    ]
    const res = await fetch(`${target}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ms.model?.key,
        messages: titleMessages,
        stream: false,
        temperature: 0.3,
        max_tokens: 32,
        reasoning_budget: 0,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
    let raw = data.choices?.[0]?.message?.content ?? ''
    raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim() // strip any leaked reasoning
    let title = raw.replace(/^["'“”]+|["'“”]+$/g, '').replace(/[.!?]+$/, '').trim().slice(0, 60)
    // Fallback: a snippet of the first user message if the model gave nothing usable.
    if (!title) {
      const firstUser = prevMessages.find((m) => m.role === 'user')?.content
      if (typeof firstUser === 'string') {
        title = firstUser.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ').slice(0, 60)
      }
    }
    if (title && d.db.getConversation(convId)?.title === 'New chat') {
      d.db.updateConversation(convId, { title })
    }
  } catch { /* silently ignore */ }
}
