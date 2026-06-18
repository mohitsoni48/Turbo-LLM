// Chat API routes (spec 07). Conversations CRUD + SSE streaming send + message actions.
import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { Deps } from '../deps'
import { clampMaxTokens } from '../config/config'
import { engineModelAlias } from '../engines/compat'
import { getSysInfo } from '../sysinfo/sysinfo'
import type { MessageStats, ToolCallRecord } from './db'

// Track in-flight abort controllers per conversation id.
const inflight = new Map<string, AbortController>()

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'
const CHAN_ANALYSIS_OPEN = '<|channel|>analysis<|message|>'
const CHAN_CLOSE = '<|end|>'
const CHAN_FINAL_SKIP = '<|start|>assistant<|channel|>final<|message|>'

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
    const b = await body<{ title?: string; systemPrompt?: string; modelKey?: string; toolPolicy?: string }>(c)
    const conv = db.createConversation({ title: b.title, systemPrompt: b.systemPrompt, modelKey: b.modelKey, toolPolicy: b.toolPolicy })
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
    const b = await body<{ title?: string; systemPrompt?: string; sampling?: Record<string, unknown> }>(c)
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
    const images = b.images ?? []
    const textAttachments = b.textAttachments ?? []
    // A message is valid if it has typed text OR carries an image or file
    // attachment — image-only / file-only sends are allowed.
    if (!content && images.length === 0 && textAttachments.length === 0)
      return err(c, 400, 'invalid_input', 'Type a message or attach an image or file.')

    const conv = db.getConversation(convId, true)
    if (!conv) return err(c, 404, 'not_found', 'Conversation not found.')

    const ms = d.manager.status()
    if (ms.state !== 'running' || !ms.model) return err(c, 409, 'model_not_loaded', 'Load a model first.')
    const target = d.manager.target()
    if (!target) return err(c, 409, 'model_not_loaded', 'Engine not running.')

    if (inflight.has(convId)) return err(c, 409, 'generation_in_flight', 'A generation is already running for this conversation.')

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
      const fullContent = b.docContext
        ? (content ? `${b.docContext}\n\n${content}` : b.docContext)
        : content
      const userContent: unknown = images.length
        ? [
            ...(fullContent ? [{ type: 'text', text: fullContent }] : []),
            ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
          ]
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
 * Streams an assistant turn with optional agentic tool-calling loop. Posts to the
 * engine, relays delta/reasoning/progress/tool_call SSE events, parses inline <think>
 * tags, executes tool calls and loops (up to MAX_TOOL_ITER rounds), persists the final
 * message + stats, and fires auto-title. Shared by the messages and continue endpoints.
 */
async function runGeneration(d: Deps, stream: StreamHandle, ctx: GenerationCtx): Promise<void> {
  const { db } = d
  const { convId, conv, assistantMsg, ms, target, ac, disableThinking } = ctx

  // Map conversation sampling overrides (camelCase) to the engine's snake_case names.
  const convS = conv.sampling ?? {}
  const SAMPLING_KEYS: Record<string, string> = {
    temp: 'temperature', topP: 'top_p', topK: 'top_k', minP: 'min_p',
    repeatPenalty: 'repeat_penalty', presencePenalty: 'presence_penalty',
    frequencyPenalty: 'frequency_penalty',
  }
  const samplingOverride: Record<string, unknown> = {}
  for (const [camel, snake] of Object.entries(SAMPLING_KEYS)) {
    if (camel in convS) samplingOverride[snake] = convS[camel]
  }
  for (const [k, v] of Object.entries(convS)) {
    if (!(k in SAMPLING_KEYS) && k !== 'stop') samplingOverride[k] = v
  }
  const stopStrings = convS.stop as string[] | undefined

  const maxLimit = d.store.snapshot().modelDefaults.maxTokens ?? 0

  // ── Agentic tool loop ──────────────────────────────────────────────────────
  // engineMessages is extended each round with tool results. Start from ctx copy
  // so the original array is never mutated (continue endpoint reuses it).
  const iterMessages: { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string }[] =
    ctx.engineMessages.map((m) => ({ role: m.role, content: m.content }))

  const MAX_TOOL_ITER = 10
  let toolIter = 0

  // Accumulated across all tool iterations for persistence
  let fullContent = ''
  let fullReasoning = ''
  const allToolCalls: ToolCallRecord[] = []

  // Stats from the final (non-tool) round
  const requestStart = Date.now()
  let ttftMs = 0
  let thinkStart = 0
  let thinkEnd = 0
  let finalUsage: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } = {}
  let finalTimings: Record<string, number> = {}
  let aborted = false
  let liveOut = 0

  d.manager.generationStart()
  try {
    // Get tool definitions once (or empty for engines that don't support tools)
    const toolDefs = d.tools ? await d.tools.buildToolDefinitions() : []

    outerLoop: while (toolIter <= MAX_TOOL_ITER) {
      toolIter++

      const reqBody: Record<string, unknown> = {
        model: engineModelAlias(d.registry.active()?.kind ?? '') ?? ms.model!.key,
        messages: iterMessages,
        stream: true,
        stream_options: { include_usage: true },
        return_progress: true,
        ...samplingOverride,
      }
      if (stopStrings?.length) reqBody.stop = stopStrings
      const cappedMax = clampMaxTokens(reqBody.max_tokens as number | undefined, maxLimit)
      if (cappedMax != null) reqBody.max_tokens = cappedMax
      else delete reqBody.max_tokens
      if (disableThinking) {
        reqBody.reasoning_budget = 0
        reqBody.chat_template_kwargs = { enable_thinking: false }
      }
      // Attach tools only when the engine kind supports them (llama.cpp + TurboQuant).
      // MLX/vLLM passthrough is fine too — they ignore unknown fields gracefully.
      if (toolDefs.length > 0) reqBody.tools = toolDefs
      // Force web_search on the first two iterations when the conversation has a
      // force_web_search policy (e.g. Research persona). This guarantees at least
      // two distinct searches before the model composes its answer. Iteration 3+
      // use "auto" so the model can continue searching or finish as it sees fit.
      if (
        conv.toolPolicy === 'force_web_search' &&
        toolIter <= 2 &&
        toolDefs.some((t) => t.function.name === 'web_search')
      ) {
        reqBody.tool_choice = { type: 'function', function: { name: 'web_search' } }
      }

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

      const cancelReader = () => void reader.cancel()
      if (ac.signal.aborted) {
        cancelReader()
      } else {
        ac.signal.addEventListener('abort', cancelReader, { once: true })
      }

      // Per-round state
      let roundContent = ''
      type ParsePhase = 'initial' | 'reasoning' | 'skipFinal' | 'content'
      let parsePhase: ParsePhase = 'initial'
      let parseIsChannel = false
      let parseBuf = ''
      let finishReason = ''
      // Accumulate streaming tool_calls by index (OpenAI format: fragmented across chunks)
      const pendingToolCalls = new Map<number, { id: string; name: string; argsBuffer: string }>()

      roundLoop: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') break roundLoop

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

          if (chunk.usage) finalUsage = chunk.usage as typeof finalUsage
          if (chunk.timings) finalTimings = chunk.timings as typeof finalTimings

          const choices = chunk.choices as Array<{
            delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
            finish_reason?: string
          }> | undefined
          if (!choices?.length) continue

          if (choices[0].finish_reason) finishReason = choices[0].finish_reason
          const delta = choices[0].delta ?? {}

          // Accumulate streaming tool_call fragments (OpenAI: id+name only in first chunk,
          // arguments fragment across all chunks for that index).
          if (delta.tool_calls?.length) {
            for (const tc of delta.tool_calls) {
              if (!pendingToolCalls.has(tc.index)) {
                pendingToolCalls.set(tc.index, { id: '', name: '', argsBuffer: '' })
              }
              const entry = pendingToolCalls.get(tc.index)!
              if (tc.id && !entry.id) entry.id = tc.id
              if (tc.function?.name && !entry.name) entry.name = tc.function.name
              if (tc.function?.arguments) entry.argsBuffer += tc.function.arguments
            }
            continue
          }

          // Reasoning content — llama-server uses `reasoning_content`, mlx-lm uses `reasoning`.
          const rc = (delta.reasoning_content ?? delta.reasoning) as string | undefined
          if (rc) {
            if (!thinkStart) thinkStart = Date.now()
            thinkEnd = Date.now()
            fullReasoning += rc
            await stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ delta: rc }) })
            continue
          }

          const raw_content = delta.content ?? ''
          if (!raw_content) continue

          parseBuf += raw_content

          // State machine handles <think>...</think> (llama.cpp) and
          // <|channel|>analysis<|message|>...<|end|> (GPT-OSS channel format).
          while (parseBuf.length > 0) {
            if (parsePhase === 'initial') {
              const thinkIdx = parseBuf.indexOf(THINK_OPEN)
              const chanIdx  = parseBuf.indexOf(CHAN_ANALYSIS_OPEN)
              const hasThink = thinkIdx >= 0
              const hasChan  = chanIdx >= 0
              const useThink = hasThink && (!hasChan || thinkIdx <= chanIdx)
              const openIdx  = useThink ? thinkIdx : hasChan ? chanIdx : -1
              const openTag  = useThink ? THINK_OPEN : CHAN_ANALYSIS_OPEN

              if (openIdx === 0) {
                parseIsChannel = !useThink
                parsePhase = 'reasoning'
                if (!thinkStart) thinkStart = Date.now()
                parseBuf = parseBuf.slice(openTag.length)
              } else if (openIdx > 0) {
                const before = parseBuf.slice(0, openIdx)
                fullContent += before
                roundContent += before
                if (!ttftMs) ttftMs = Date.now() - requestStart
                await stream.writeSSE({ event: 'delta', data: JSON.stringify({ delta: before }) })
                parseIsChannel = !useThink
                parsePhase = 'reasoning'
                if (!thinkStart) thinkStart = Date.now()
                parseBuf = parseBuf.slice(openIdx + openTag.length)
              } else {
                // 29-char lookahead: safe threshold to detect the 30-char CHAN_ANALYSIS_OPEN
                // tag before flushing. Tradeoff: non-reasoning responses buffer ~1 extra
                // cycle before first delta (TTFT impact ≈ 30 chars / tok/s).
                const safeLen = parseBuf.length - (CHAN_ANALYSIS_OPEN.length - 1)
                if (safeLen > 0) {
                  const flush = parseBuf.slice(0, safeLen)
                  parseBuf = parseBuf.slice(safeLen)
                  fullContent += flush
                  roundContent += flush
                  if (!ttftMs) ttftMs = Date.now() - requestStart
                  d.manager.setLiveGen({ phase: 'gen', pct: 0, outputTokens: ++liveOut })
                  await stream.writeSSE({ event: 'delta', data: JSON.stringify({ delta: flush }) })
                  parsePhase = 'content'
                } else {
                  break
                }
              }
            } else if (parsePhase === 'reasoning') {
              const closeTag = parseIsChannel ? CHAN_CLOSE : THINK_CLOSE
              const closeIdx = parseBuf.indexOf(closeTag)
              if (closeIdx >= 0) {
                if (closeIdx > 0) {
                  const chunk = parseBuf.slice(0, closeIdx)
                  fullReasoning += chunk
                  await stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ delta: chunk }) })
                }
                thinkEnd = Date.now()
                const wasChannel = parseIsChannel
                parseBuf = parseBuf.slice(closeIdx + closeTag.length)
                parsePhase = wasChannel ? 'skipFinal' : 'content'
                if (!wasChannel && parseBuf) {
                  fullContent += parseBuf
                  roundContent += parseBuf
                  if (!ttftMs) ttftMs = Date.now() - requestStart
                  await stream.writeSSE({ event: 'delta', data: JSON.stringify({ delta: parseBuf }) })
                  parseBuf = ''
                }
              } else if (parseBuf.length >= closeTag.length) {
                const safe = parseBuf.length - (closeTag.length - 1)
                const chunk = parseBuf.slice(0, safe)
                parseBuf = parseBuf.slice(safe)
                thinkEnd = Date.now()
                fullReasoning += chunk
                await stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ delta: chunk }) })
              } else {
                break
              }
            } else if (parsePhase === 'skipFinal') {
              if (parseBuf.startsWith(CHAN_FINAL_SKIP)) {
                parseBuf = parseBuf.slice(CHAN_FINAL_SKIP.length)
                parsePhase = 'content'
              } else if (CHAN_FINAL_SKIP.startsWith(parseBuf) && parseBuf.length < CHAN_FINAL_SKIP.length) {
                break
              } else {
                // Unexpected prefix before skip token (e.g. whitespace between <|end|> and
                // <|start|>assistant…). Find the token anywhere in the buffer so content
                // after it isn't discarded along with the framing bytes.
                const skipIdx = parseBuf.indexOf(CHAN_FINAL_SKIP)
                parseBuf = skipIdx >= 0 ? parseBuf.slice(skipIdx + CHAN_FINAL_SKIP.length) : ''
                parsePhase = 'content'
              }
            } else {
              if (!ttftMs) ttftMs = Date.now() - requestStart
              fullContent += parseBuf
              roundContent += parseBuf
              d.manager.setLiveGen({ phase: 'gen', pct: 0, outputTokens: ++liveOut })
              await stream.writeSSE({ event: 'delta', data: JSON.stringify({ delta: parseBuf }) })
              parseBuf = ''
              break
            }
          }
        }
      }
      ac.signal.removeEventListener('abort', cancelReader)

      // Flush lookahead buffer at end-of-stream.
      if (parseBuf) {
        if (parsePhase === 'reasoning') {
          fullReasoning += parseBuf
          await stream.writeSSE({ event: 'reasoning', data: JSON.stringify({ delta: parseBuf }) })
        } else {
          // Emit whatever's buffered, even if we're in skipFinal (truncated stream).
          fullContent += parseBuf
          roundContent += parseBuf
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ delta: parseBuf }) })
        }
      }

      // ── Tool call execution ──────────────────────────────────────────────
      if ((finishReason === 'tool_calls' || pendingToolCalls.size > 0) && d.tools && toolIter <= MAX_TOOL_ITER) {
        const roundToolCalls = Array.from(pendingToolCalls.values())

        // Add the assistant message (with tool_calls) to iterMessages for the next round
        iterMessages.push({
          role: 'assistant',
          content: roundContent || null,
          tool_calls: roundToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.argsBuffer },
          })),
        })

        for (const tc of roundToolCalls) {
          let parsedArgs: Record<string, unknown>
          try { parsedArgs = JSON.parse(tc.argsBuffer || '{}') as Record<string, unknown> }
          catch { parsedArgs = {} }

          // Emit pending event so the frontend can show "calling..."
          await stream.writeSSE({
            event: 'tool_call',
            data: JSON.stringify({ id: tc.id, name: tc.name, args: parsedArgs, status: 'pending' }),
          })

          let result = ''
          let callError: string | undefined
          try {
            result = await d.tools.executeTool({ id: tc.id, name: tc.name, args: parsedArgs })
          } catch (e) {
            callError = (e as Error).message
            result = `Error: ${callError}`
          }

          allToolCalls.push({ id: tc.id, name: tc.name, args: parsedArgs, result: callError ? undefined : result, error: callError })

          // Emit done event with result
          await stream.writeSSE({
            event: 'tool_call',
            data: JSON.stringify({ id: tc.id, name: tc.name, args: parsedArgs, status: callError ? 'error' : 'done', result }),
          })

          // Inject tool result into iterMessages
          iterMessages.push({ role: 'tool', content: result, tool_call_id: tc.id })
        }

        // Continue to next round
        continue outerLoop
      }

      // No tool calls (or tools not available) — done
      break outerLoop
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

  const stats: Partial<MessageStats> = {
    ttftMs,
    totalMs,
    thinkMs,
    ctxUsed: (finalUsage.prompt_tokens ?? 0) + (finalUsage.completion_tokens ?? 0),
    ctxMax,
    model: ms.model?.name ?? '',
    aborted,
  }
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
    stats.promptTokens = fullPrompt
    stats.genTokens    = finalUsage.completion_tokens ?? 0
    stats.genMs        = totalMs - ttftMs
    stats.tps          = stats.genMs > 0 ? Math.round((stats.genTokens / stats.genMs) * 1000 * 10) / 10 : 0
    stats.cachedTokens = cachedExplicit ?? 0
  }

  db.updateMessage(assistantMsg.id, { content: fullContent, reasoning: fullReasoning, toolCalls: allToolCalls, stats })
  db.touchConversation(convId)

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

  if (!aborted && conv.title === 'New chat' && d.store.snapshot().daemon.autoGenerateTitles) {
    setTimeout(() => { void autoTitle(d, convId, ctx.engineMessages, fullContent, target) }, 1000)
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
        model: engineModelAlias(d.registry.active()?.kind ?? '') ?? ms.model?.key,
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
