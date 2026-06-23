// ModelRouter pool-state tests (F-033 loaded-model display + F-032 KV-cache TTL).
// Contracts under test:
//   • loadedModelKeys(): the union of model keys loaded (running|starting) across the
//     primary manager AND every alive extra pool slot — so gateway-loaded models show as
//     loaded on the Models page (F-033). Dead/stopped slots are excluded.
//   • selectKvTtlEvictions(): pure past-TTL selection over the keep-N pool (F-032). Excludes
//     dead slots; ttlMs <= 0 disables. Drives the sweeper without real timers.
//   • sweepKvTtl(): no-op selection for keepN === 1; reads the configured TTL otherwise.
//
// We build only the light fakes the methods touch (Manager.status + ConfigStore.snapshot);
// registry/scanner/comfy are unused by these paths and cast through. The private extraSlots
// map is seeded directly via a typed cast — the same "reach into internals for a unit test"
// shape other tests use — since there's no public seeder that doesn't drive a real load.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ModelRouter, selectKvTtlEvictions } from './model-router'
import type { Manager, Status } from '../engines/manager'
import type { ConfigStore } from '../config/config'

/** A Manager double exposing only status() (all the tested paths read). */
function fakeManager(state: Status['state'], modelKey: string | null): Manager {
  const model = modelKey
    ? { key: modelKey, name: modelKey, quant: 'Q4', ctx: 4096, vision: false }
    : null
  return {
    status: (): Status => ({ state, err: null, port: 0, pid: 0, model, loadElapsedMs: 0 }),
  } as unknown as Manager
}

/** A ConfigStore double returning a fixed gateway snapshot (keepN + kvCacheTtlMs). */
function fakeStore(gateway: { keepN: number; kvCacheTtlMs: number }): ConfigStore {
  return {
    snapshot: () => ({ gateway: { autoSwap: true, ...gateway } }),
  } as unknown as ConfigStore
}

interface PoolSlotShape {
  manager: Manager
  modelKey: string
  lastUsedMs: number
}

/** Build a router with the given primary manager + seeded extra pool slots. The extraSlots
 *  map is private; we set it through a narrow cast rather than driving a real load. */
function router(
  primary: Manager,
  store: ConfigStore,
  slots: PoolSlotShape[] = [],
): ModelRouter {
  const r = new ModelRouter(store, {} as never, primary, {} as never, undefined)
  const map = new Map<string, PoolSlotShape>()
  for (const s of slots) map.set(s.modelKey, s)
  ;(r as unknown as { extraSlots: Map<string, PoolSlotShape> }).extraSlots = map
  return r
}

const STORE = fakeStore({ keepN: 3, kvCacheTtlMs: 300_000 })

// ── loadedModelKeys (F-033) ───────────────────────────────────────────────────
test('loadedModelKeys: empty when nothing is loaded', () => {
  const r = router(fakeManager('stopped', null), STORE)
  assert.deepEqual([...r.loadedModelKeys()], [])
})

test('loadedModelKeys: primary-only returns just the primary key', () => {
  const r = router(fakeManager('running', 'llama-8b'), STORE)
  assert.deepEqual([...r.loadedModelKeys()].sort(), ['llama-8b'])
})

test('loadedModelKeys: primary + alive pool slots returns the union', () => {
  const r = router(fakeManager('running', 'llama-8b'), STORE, [
    { manager: fakeManager('running', 'qwen-7b'), modelKey: 'qwen-7b', lastUsedMs: 0 },
    { manager: fakeManager('starting', 'gemma-2b'), modelKey: 'gemma-2b', lastUsedMs: 0 },
  ])
  assert.deepEqual([...r.loadedModelKeys()].sort(), ['gemma-2b', 'llama-8b', 'qwen-7b'])
})

test('loadedModelKeys: includes starting state and excludes dead/stopped slots', () => {
  const r = router(fakeManager('starting', 'primary-loading'), STORE, [
    { manager: fakeManager('running', 'alive'), modelKey: 'alive', lastUsedMs: 0 },
    { manager: fakeManager('stopped', 'dead'), modelKey: 'dead', lastUsedMs: 0 },
    { manager: fakeManager('error', 'crashed'), modelKey: 'crashed', lastUsedMs: 0 },
  ])
  assert.deepEqual([...r.loadedModelKeys()].sort(), ['alive', 'primary-loading'])
})

test('loadedModelKeys: pool-only (primary stopped) still reports pool slots', () => {
  const r = router(fakeManager('stopped', null), STORE, [
    { manager: fakeManager('running', 'qwen-7b'), modelKey: 'qwen-7b', lastUsedMs: 0 },
  ])
  assert.deepEqual([...r.loadedModelKeys()], ['qwen-7b'])
})

// ── selectKvTtlEvictions (F-032, pure selection) ──────────────────────────────
test('selectKvTtlEvictions: picks only alive slots idle past the TTL', () => {
  const now = 1_000_000
  const ttl = 300_000
  const slots = [
    { modelKey: 'fresh', lastUsedMs: now - 10_000, alive: true }, // recent → keep
    { modelKey: 'stale', lastUsedMs: now - 400_000, alive: true }, // old → evict
    { modelKey: 'dead-stale', lastUsedMs: now - 999_999, alive: false }, // old but dead → skip
  ]
  assert.deepEqual(selectKvTtlEvictions(slots, ttl, now), ['stale'])
})

test('selectKvTtlEvictions: exactly-at-TTL is not yet evicted (strictly greater)', () => {
  const now = 1_000_000
  const ttl = 300_000
  const slots = [{ modelKey: 'edge', lastUsedMs: now - ttl, alive: true }]
  assert.deepEqual(selectKvTtlEvictions(slots, ttl, now), [], 'idle == TTL is not past it')
  const slotsPast = [{ modelKey: 'edge', lastUsedMs: now - ttl - 1, alive: true }]
  assert.deepEqual(selectKvTtlEvictions(slotsPast, ttl, now), ['edge'], 'idle > TTL evicts')
})

test('selectKvTtlEvictions: ttlMs <= 0 disables the sweep', () => {
  const now = 1_000_000
  const slots = [{ modelKey: 'whatever', lastUsedMs: 0, alive: true }]
  assert.deepEqual(selectKvTtlEvictions(slots, 0, now), [])
  assert.deepEqual(selectKvTtlEvictions(slots, -5, now), [])
})

// ── sweepKvTtl (F-032, router-driven, injected clock) ─────────────────────────
test('sweepKvTtl: no-op for keepN === 1 (no pool to evict toward)', () => {
  const store = fakeStore({ keepN: 1, kvCacheTtlMs: 300_000 })
  const now = 1_000_000
  const r = router(fakeManager('running', 'only'), store, [
    // Even a wildly stale extra slot is ignored when keepN === 1.
    { manager: fakeManager('running', 'ghost'), modelKey: 'ghost', lastUsedMs: now - 999_999 },
  ])
  assert.deepEqual(r.sweepKvTtl(now), [])
})

test('sweepKvTtl: selects past-TTL pool slots when keepN > 1', () => {
  const store = fakeStore({ keepN: 3, kvCacheTtlMs: 300_000 })
  const now = 1_000_000
  const r = router(fakeManager('running', 'active'), store, [
    { manager: fakeManager('running', 'fresh'), modelKey: 'fresh', lastUsedMs: now - 1_000 },
    { manager: fakeManager('running', 'idle'), modelKey: 'idle', lastUsedMs: now - 400_000 },
  ])
  assert.deepEqual(r.sweepKvTtl(now), ['idle'])
})

test('sweepKvTtl: kvCacheTtlMs === 0 disables eviction even with idle pool slots', () => {
  const store = fakeStore({ keepN: 3, kvCacheTtlMs: 0 })
  const now = 1_000_000
  const r = router(fakeManager('running', 'active'), store, [
    { manager: fakeManager('running', 'idle'), modelKey: 'idle', lastUsedMs: now - 999_999 },
  ])
  assert.deepEqual(r.sweepKvTtl(now), [])
})
