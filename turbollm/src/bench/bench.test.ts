import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickKvQuants, betterBySpeed, decideKvToBench } from './bench'

// ---- pickKvQuants: quality-preserving KV sweep, base-first ------------------

test('pickKvQuants: stock llama.cpp (no turbo) → f16 + q8_0 only', () => {
  const stock = ['f16', 'q8_0', 'q4_0', 'q4_1', 'q5_0', 'q5_1', 'q8_1']
  assert.deepEqual(pickKvQuants('f16', stock), ['f16', 'q8_0'])
})

test('pickKvQuants: TurboQuant fork → adds turbo4 (never turbo2/turbo3)', () => {
  const turbo = ['f16', 'q8_0', 'q4_0', 'q5_1', 'turbo2', 'turbo3', 'turbo4']
  assert.deepEqual(pickKvQuants('f16', turbo), ['f16', 'q8_0', 'turbo4'])
})

test('pickKvQuants: base type comes first and is de-duplicated', () => {
  const turbo = ['f16', 'q8_0', 'turbo2', 'turbo3', 'turbo4']
  assert.deepEqual(pickKvQuants('q8_0', turbo), ['q8_0', 'f16', 'turbo4'])
})

test('pickKvQuants: never auto-adds lower-bit types, but keeps the user\'s own choice', () => {
  const stock = ['f16', 'q8_0', 'q4_0', 'q5_1']
  // q4_0 is lower-quality and never *added*, but if the user explicitly set it, it stays (first).
  assert.deepEqual(pickKvQuants('q4_0', stock), ['q4_0', 'f16', 'q8_0'])
  // q5_1 is never a quality-preserving candidate.
  assert.ok(!pickKvQuants('f16', stock).includes('q5_1'))
})

test('pickKvQuants: unprobed engine (empty kvTypes) → base type only', () => {
  assert.deepEqual(pickKvQuants('f16', []), ['f16'])
  assert.deepEqual(pickKvQuants('q8_0', []), ['q8_0'])
})

// ---- betterBySpeed: output t/s primary, prefill the tie-break ---------------

test('betterBySpeed: clearly higher generation t/s wins', () => {
  assert.equal(betterBySpeed({ tps: 75, prefillTps: 100 }, { tps: 60, prefillTps: 999 }), true)
  assert.equal(betterBySpeed({ tps: 60, prefillTps: 999 }, { tps: 75, prefillTps: 100 }), false)
})

test('betterBySpeed: within 5% on generation → faster prefill breaks the tie', () => {
  // 72 vs 73 is a ~1.4% gap → tie → prefill decides.
  assert.equal(betterBySpeed({ tps: 72, prefillTps: 900 }, { tps: 73, prefillTps: 800 }), true)
  assert.equal(betterBySpeed({ tps: 72, prefillTps: 700 }, { tps: 73, prefillTps: 800 }), false)
})

test('betterBySpeed: a >5% generation deficit is NOT rescued by prefill', () => {
  // 35B reality: turbo4 has faster prefill but ~17% slower generation than q8_0 → q8_0 wins.
  const turbo4 = { tps: 60.3, prefillTps: 983 }
  const q8_0 = { tps: 72.3, prefillTps: 892 }
  assert.equal(betterBySpeed(turbo4, q8_0), false)
  assert.equal(betterBySpeed(q8_0, turbo4), true)
})

test('betterBySpeed: 27B reality — turbo4 wins on both', () => {
  const turbo4 = { tps: 24.6, prefillTps: 1288 }
  const q8_0 = { tps: 10.8, prefillTps: 846 }
  assert.equal(betterBySpeed(turbo4, q8_0), true)
})

test('betterBySpeed: null / zero handling', () => {
  assert.equal(betterBySpeed({ tps: 10, prefillTps: null }, { tps: 0, prefillTps: null }), true)
  assert.equal(betterBySpeed({ tps: null, prefillTps: null }, { tps: null, prefillTps: null }), false)
})

// ---- decideKvToBench: VRAM-reasoned KV pruning (the fast path) ---------------

const TURBO = ['f16', 'q8_0', 'turbo4'] // TurboQuant fork
const STOCK = ['f16', 'q8_0'] // official llama.cpp

test('decideKvToBench: tiny KV swing → tune only the largest (f16), no sweep', () => {
  assert.deepEqual(decideKvToBench(300, TURBO), ['f16'])
  assert.deepEqual(decideKvToBench(1024, TURBO), ['f16']) // boundary is inclusive
  assert.deepEqual(decideKvToBench(800, STOCK), ['f16'])
})

test('decideKvToBench: 35B (hybrid MoE, ~3 GB swing) → turbo4 + q8_0, picks q8_0 once measured', () => {
  // The ~3 GB f16↔turbo4 swing puts us in the big-KV path; measurement then prefers q8_0.
  assert.deepEqual(decideKvToBench(3186, TURBO), ['turbo4', 'q8_0'])
})

test('decideKvToBench: 27B / Gemma (huge KV) → turbo4 + q8_0 (measurement splits them)', () => {
  assert.deepEqual(decideKvToBench(13000, TURBO), ['turbo4', 'q8_0'])
  assert.deepEqual(decideKvToBench(Number.MAX_SAFE_INTEGER, TURBO), ['turbo4', 'q8_0'])
})

test('decideKvToBench: un-sizable (spread < 0) is treated as big-KV, safely', () => {
  assert.deepEqual(decideKvToBench(-1, TURBO), ['turbo4', 'q8_0'])
})

test('decideKvToBench: stock engine (no turbo) → just q8_0 in the big-KV regime', () => {
  assert.deepEqual(decideKvToBench(5000, STOCK), ['q8_0'])
  assert.deepEqual(decideKvToBench(-1, STOCK), ['q8_0'])
})
