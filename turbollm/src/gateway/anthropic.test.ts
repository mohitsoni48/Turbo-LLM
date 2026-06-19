// Gateway translation tests: the max-tokens clamp, and the live-progress wiring on
// the Anthropic stream translator (prefill % + token count published to the engine
// card, with prompt_progress chunks consumed rather than forwarded to the client).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampMaxTokens } from '../config/config'
import { mapToOpenAI, streamToAnthropic, type LiveProgress } from './anthropic'

// ── clampMaxTokens ──────────────────────────────────────────────────────────

test('clampMaxTokens: limit 0 (unlimited) leaves the request untouched', () => {
  assert.equal(clampMaxTokens(5000, 0), 5000)
  assert.equal(clampMaxTokens(undefined, 0), undefined)
})

test('clampMaxTokens: caps a larger request down to the limit', () => {
  assert.equal(clampMaxTokens(32000, 4096), 4096)
})

test('clampMaxTokens: keeps a smaller request as-is', () => {
  assert.equal(clampMaxTokens(1000, 4096), 1000)
})

test('clampMaxTokens: no request value falls back to the limit', () => {
  assert.equal(clampMaxTokens(undefined, 4096), 4096)
  assert.equal(clampMaxTokens(0, 4096), 4096)
})

// ── mapToOpenAI injects return_progress when streaming ──────────────────────

test('mapToOpenAI sets return_progress only for streaming requests', () => {
  const streamed = mapToOpenAI({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 10, stream: true })
  assert.equal(streamed.return_progress, true)
  const nonStreamed = mapToOpenAI({ messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 })
  assert.equal(nonStreamed.return_progress, undefined)
})

// ── streamToAnthropic live progress ─────────────────────────────────────────

/** Build a ReadableStream of OpenAI-style SSE bytes from raw line strings. */
function sseStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(l + '\n'))
      controller.close()
    },
  })
}

test('streamToAnthropic publishes prefill % then token counts, and never forwards prompt_progress', async () => {
  const upstream = sseStream([
    'data: {"prompt_progress":{"processed":50,"total":100}}',
    'data: {"prompt_progress":{"processed":100,"total":100}}',
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    'data: {"choices":[{"delta":{"content":" world"}}]}',
    'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}',
    'data: [DONE]',
  ])

  const live: LiveProgress[] = []
  const events: { event: string; data: string }[] = []
  for await (const evt of streamToAnthropic(upstream, 'test-model', 'msg_1', undefined, (p) => live.push(p))) {
    events.push(evt)
  }

  // Prefill progress surfaced as a percent, then a running gen token count.
  assert.deepEqual(
    live.filter((p) => p.phase === 'prompt').map((p) => p.pct),
    [50, 100],
  )
  assert.deepEqual(
    live.filter((p) => p.phase === 'gen').map((p) => p.outputTokens),
    [1, 2],
  )

  // The client stream must NOT contain the internal prompt_progress chunks.
  const blob = events.map((e) => e.data).join('\n')
  assert.ok(!blob.includes('prompt_progress'), 'prompt_progress must be consumed, not forwarded')

  // The actual text still streamed through as Anthropic text_delta events.
  assert.ok(blob.includes('Hello') && blob.includes('world'))
})

// ── streamToAnthropic usage mapping ─────────────────────────────────────────

test('streamToAnthropic maps prompt_tokens/completion_tokens to Anthropic usage with cache reuse', async () => {
  const upstream = sseStream([
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50},"timings":{"prompt_n_reuse":20}}',
    'data: [DONE]',
  ])

  const events: { event: string; data: string }[] = []
  for await (const evt of streamToAnthropic(upstream, 'test-model', 'msg_2')) {
    events.push(evt)
  }

  const delta = events.find((e) => e.event === 'message_delta')
  assert.ok(delta, 'message_delta event must be emitted')
  const parsed = JSON.parse(delta!.data) as { usage: { output_tokens: number; input_tokens: number; cache_read_input_tokens: number } }
  assert.equal(parsed.usage.output_tokens, 50)
  assert.equal(parsed.usage.input_tokens, 100)
  assert.equal(parsed.usage.cache_read_input_tokens, 20)
})

test('streamToAnthropic emits cache_read_input_tokens: 0 when no timings field', async () => {
  const upstream = sseStream([
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    'data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":80,"completion_tokens":30}}',
    'data: [DONE]',
  ])

  const events: { event: string; data: string }[] = []
  for await (const evt of streamToAnthropic(upstream, 'test-model', 'msg_3')) {
    events.push(evt)
  }

  const delta = events.find((e) => e.event === 'message_delta')
  assert.ok(delta, 'message_delta event must be emitted')
  const parsed = JSON.parse(delta!.data) as { usage: { output_tokens: number; input_tokens: number; cache_read_input_tokens: number } }
  assert.equal(parsed.usage.output_tokens, 30)
  assert.equal(parsed.usage.input_tokens, 80)
  assert.equal(parsed.usage.cache_read_input_tokens, 0)
})
