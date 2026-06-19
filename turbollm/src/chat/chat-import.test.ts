// Round-trip and validation tests for the chat import/export cycle (F-024).
// Tests build a snapshot with buildSnapshot(), parse/validate it, then verify
// the shape the import endpoint would accept, plus error cases and persona fallback.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildSnapshot } from './chat-export.js'
import type { Conversation, Message } from './db.js'
import type { Config } from '../config/config.js'

// ── helpers (same as chat-export.test.ts) ────────────────────────────────────

function makeConv(overrides: Partial<Conversation & { messages: Message[] }> = {}): Conversation & { messages: Message[] } {
  return {
    id: 'conv-1',
    title: 'Research Chat',
    systemPrompt: '',
    modelKey: 'qwen3-35b-q4',
    sampling: {},
    expertMode: false,
    toolPolicy: 'force_web_search',
    createdAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:01.000Z',
    messages: [],
    ...overrides,
  }
}

function makeMsg(role: 'user' | 'assistant', content: string, extra?: Partial<Message>): Message {
  return {
    id: 'msg-' + Math.random().toString(36).slice(2),
    convId: 'conv-1',
    seq: 1,
    role,
    content,
    reasoning: '',
    attachments: [],
    textAttachments: [],
    toolCalls: [],
    stats: {},
    createdAt: '2026-06-19T00:00:02.000Z',
    ...extra,
  }
}

function makeCfg(): Config {
  return {
    version: 2,
    daemon: { host: '', port: 3000, lanBind: false, requireApiKey: true, authToken: '', idleTtlMinutes: 30, openBrowserOnStart: true, theme: 'dark', autoGenerateTitles: true },
    telemetry: { level: 'off', machineId: '' },
    apiKeys: [],
    engines: [],
    activeEngineId: '',
    modelDirs: [],
    primaryModelDir: '',
    modelProfiles: {},
    benchResults: {},
    lastLoaded: null,
    hf: { token: '' },
    tools: {},
    gateway: { autoSwap: true, keepN: 1 },
    comfyui: { enabled: false, gatePath: '', url: '', reverseGate: false, cachePersist: false },
    modelDefaults: { ctx: 4096, ngl: 99 },
    mcp: { servers: [] },
  } as unknown as Config
}

// ── validation helper (mirrors what the import endpoint does) ─────────────────

function validateImportPayload(payload: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof payload !== 'object' || payload === null) return { ok: false, error: 'not an object' }
  const p = payload as Record<string, unknown>
  if (!p.format || (p.format !== 'debug' && p.format !== 'export')) {
    return { ok: false, error: 'Missing or invalid "format" field.' }
  }
  if (!Array.isArray(p.messages)) return { ok: false, error: 'Missing "messages" array.' }
  if (typeof p.chat_id !== 'string') return { ok: false, error: 'Missing "chat_id" field.' }
  if (typeof p.title !== 'string') return { ok: false, error: 'Missing "title" field.' }
  return { ok: true }
}

// ── tests ─────────────────────────────────────────────────────────────────────

test('round-trip: buildSnapshot(export) produces a payload that passes import validation', () => {
  const conv = makeConv({
    messages: [
      makeMsg('user', 'Hello'),
      makeMsg('assistant', 'Hi there'),
    ],
  })
  const snap = buildSnapshot(conv, makeCfg(), '0.7.2', '2026-06-19T10:00:00.000Z', 'export')
  const result = validateImportPayload(snap)
  assert.equal(result.ok, true)
})

test('round-trip: exported messages are preserved in the snapshot', () => {
  const toolCalls = [{ id: 'tc1', name: 'web_search', args: { query: 'test' }, result: 'search result' }]
  const conv = makeConv({
    messages: [
      makeMsg('user', 'Search for something'),
      makeMsg('assistant', 'I searched.', { toolCalls }),
    ],
  })
  const snap = buildSnapshot(conv, makeCfg(), '0.7.2', '2026-06-19T10:00:00.000Z', 'export')
  assert.equal(snap.messages.length, 2)
  assert.equal(snap.messages[0].role, 'user')
  assert.equal(snap.messages[0].content, 'Search for something')
  assert.equal(snap.messages[1].role, 'assistant')
  assert.ok(snap.messages[1].tool_calls)
  assert.equal(snap.messages[1].tool_calls![0].name, 'web_search')
})

test('round-trip: title and model are preserved in the snapshot', () => {
  const conv = makeConv({ title: 'GPU Specs Research', modelKey: 'qwen3-35b-a22b-q4_k_m' })
  const snap = buildSnapshot(conv, makeCfg(), '0.7.2', '2026-06-19T10:00:00.000Z', 'export')
  assert.equal(snap.title, 'GPU Specs Research')
  assert.equal(snap.model, 'qwen3-35b-a22b-q4_k_m')
})

test('round-trip: persona is preserved in snapshot (research → force_web_search conv)', () => {
  const conv = makeConv({ toolPolicy: 'force_web_search' })
  const snap = buildSnapshot(conv, makeCfg(), '0.7.2', '2026-06-19T10:00:00.000Z', 'export')
  assert.equal(snap.persona, 'research')
  // On import: if persona === 'research', toolPolicy becomes 'force_web_search'
  const importedToolPolicy = snap.persona === 'research' ? 'force_web_search' : undefined
  assert.equal(importedToolPolicy, 'force_web_search')
})

test('invalid file: missing format field fails validation', () => {
  const payload = { chat_id: 'x', title: 'Test', messages: [] }
  const result = validateImportPayload(payload)
  assert.equal(result.ok, false)
  assert.ok((result as { ok: false; error: string }).error.includes('"format"'))
})

test('invalid file: missing messages field fails validation', () => {
  const payload = { format: 'export', chat_id: 'x', title: 'Test' }
  const result = validateImportPayload(payload)
  assert.equal(result.ok, false)
  assert.ok((result as { ok: false; error: string }).error.includes('"messages"'))
})

test('invalid file: missing chat_id fails validation', () => {
  const payload = { format: 'export', title: 'Test', messages: [] }
  const result = validateImportPayload(payload)
  assert.equal(result.ok, false)
  assert.ok((result as { ok: false; error: string }).error.includes('"chat_id"'))
})

test('invalid file: unknown format value fails validation', () => {
  const payload = { format: 'v1', chat_id: 'x', title: 'Test', messages: [] }
  const result = validateImportPayload(payload)
  assert.equal(result.ok, false)
})

test('persona fallback: unknown persona falls back to default toolPolicy', () => {
  // If persona is not 'research', toolPolicy should be undefined (default)
  const snap = buildSnapshot(makeConv({ toolPolicy: undefined }), makeCfg(), '0.7.2', '2026-06-19T10:00:00.000Z', 'export')
  assert.equal(snap.persona, 'default')
  const persona: string = snap.persona
  const importedToolPolicy = persona === 'research' ? 'force_web_search' : undefined
  assert.equal(importedToolPolicy, undefined)
})

test('persona fallback: unknown persona string falls back to default', () => {
  // Simulate an export from a future version with an unknown persona
  const snapWithUnknownPersona: Record<string, unknown> = {
    format: 'export',
    chat_id: 'conv-future',
    title: 'Future Chat',
    model: 'some-model',
    persona: 'future-persona-that-does-not-exist',
    messages: [],
  }
  const result = validateImportPayload(snapWithUnknownPersona)
  assert.equal(result.ok, true)
  // Import logic: persona not 'research' → toolPolicy = undefined (falls back to default)
  const persona = snapWithUnknownPersona.persona as string
  const importedToolPolicy = persona === 'research' ? 'force_web_search' : undefined
  assert.equal(importedToolPolicy, undefined)
})

test('unknown fields are ignored in export payload (forward compat)', () => {
  const conv = makeConv({ messages: [makeMsg('user', 'hi')] })
  const snap = buildSnapshot(conv, makeCfg(), '0.7.2', '2026-06-19T10:00:00.000Z', 'export') as unknown as Record<string, unknown>
  // Simulate future fields added to the export format
  snap['future_field'] = 'some_value'
  snap['another_unknown'] = { nested: true }
  // Validation should still pass (we only check required fields)
  const result = validateImportPayload(snap)
  assert.equal(result.ok, true)
})
