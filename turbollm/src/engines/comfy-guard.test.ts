// ComfyUI GPU-coordination tests (push model). The guard's contract:
//   • acquire() while a model is loaded → force-unload it, capture it, block loads.
//   • acquire() with nothing loaded → still blocks loads (ComfyUI owns the GPU).
//   • release() → reload exactly the model that was unloaded; unblock loads.
//   • disabled → acquire/release are no-ops and loads are never blocked.
//   • the lease backstop auto-releases (reloads) if release never arrives.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ComfyGuard } from './comfy-guard'
import type { StartOpts, Status } from './manager'

/** Minimal Manager double: records start/force-stop calls, reports a scripted state. */
function fakeManager(initial: { state: Status['state']; opts: StartOpts | null }) {
  let state = initial.state
  let opts = initial.opts
  const calls = { stops: 0, forceStops: 0, starts: [] as StartOpts[] }
  return {
    mgr: {
      status: () => ({ state, err: null, port: 0, pid: 0, model: opts?.model ?? null, loadElapsedMs: 0 }) as Status,
      currentOpts: () => ((state === 'running' || state === 'starting') ? opts : null),
      stopAndWait: async (o?: { force?: boolean }) => {
        calls.stops++
        if (o?.force) calls.forceStops++
        state = 'stopped'
        opts = null
      },
      start: async (o: StartOpts) => {
        calls.starts.push(o)
        state = 'running'
        opts = o
      },
    },
    calls,
  }
}

/** ConfigStore double returning a fixed comfyui config snapshot. */
function fakeStore(comfyui: { enabled: boolean; gatePath: string }) {
  return { snapshot: () => ({ comfyui }) } as unknown as ConstructorParameters<typeof ComfyGuard>[0]
}

const OPTS = (key: string): StartOpts => ({
  engine: { id: 'e', name: 'llama', binPath: '/x', kind: 'llama-server', version: '', capabilities: { kvTypes: [], flags: [] }, addedAt: '' },
  model: { key, name: key, quant: 'Q4', ctx: 4096, vision: false },
  modelPath: `/models/${key}`,
  extraArgs: [],
})

test('acquire force-unloads the running model + blocks; release reloads exactly it', async () => {
  const { mgr, calls } = fakeManager({ state: 'running', opts: OPTS('llama-8b') })
  const g = new ComfyGuard(fakeStore({ enabled: true, gatePath: '/cn/turbollm_gate' }), mgr as never)

  await g.acquire()
  assert.equal(calls.forceStops, 1, 'should force-unload (free VRAM now)')
  assert.equal(g.isBlocked(), true, 'loads blocked while ComfyUI holds the GPU')
  assert.equal(g.snapshot().suspendedModelKey, 'llama-8b', 'remembers what to restore')

  await g.release()
  assert.equal(calls.starts.length, 1, 'should reload on release')
  assert.equal(calls.starts[0].model.key, 'llama-8b', 'reloads the exact model it unloaded')
  assert.equal(g.isBlocked(), false, 'loads unblocked after release')
  assert.equal(g.snapshot().suspendedModelKey, null, 'capture cleared')
})

test('acquire with nothing loaded still blocks; release has nothing to reload', async () => {
  const { mgr, calls } = fakeManager({ state: 'stopped', opts: null })
  const g = new ComfyGuard(fakeStore({ enabled: true, gatePath: '/cn/turbollm_gate' }), mgr as never)

  await g.acquire()
  assert.equal(calls.stops, 0, 'no model to stop')
  assert.equal(g.isBlocked(), true, 'still blocks loads — ComfyUI owns the GPU')

  await g.release()
  assert.equal(calls.starts.length, 0, 'nothing to reload — no model was loaded')
  assert.equal(g.isBlocked(), false)
})

test('repeated acquire is idempotent — one unload, stays blocked', async () => {
  const { mgr, calls } = fakeManager({ state: 'running', opts: OPTS('m') })
  const g = new ComfyGuard(fakeStore({ enabled: true, gatePath: '/cn/turbollm_gate' }), mgr as never)

  await g.acquire()
  await g.acquire()
  await g.acquire()
  assert.equal(calls.forceStops, 1, 'extra acquires must not unload again')
  assert.equal(g.isBlocked(), true)
})

test('disabled guard is fully inert (never blocks, never touches the engine)', async () => {
  const { mgr, calls } = fakeManager({ state: 'running', opts: OPTS('m') })
  const g = new ComfyGuard(fakeStore({ enabled: false, gatePath: '/cn/turbollm_gate' }), mgr as never)

  await g.acquire()
  assert.equal(calls.stops, 0, 'disabled acquire must not stop the engine')
  assert.equal(g.isBlocked(), false, 'disabled guard never blocks loads')
})

test('lease backstop auto-reloads if release never arrives', async () => {
  const { mgr, calls } = fakeManager({ state: 'running', opts: OPTS('m') })
  // Tiny lease (~60ms) via the injectable constructor param.
  const g = new ComfyGuard(fakeStore({ enabled: true, gatePath: '/cn/turbollm_gate' }), mgr as never, 0.001)
  await g.acquire()
  assert.equal(g.isBlocked(), true)
  await new Promise((r) => setTimeout(r, 200)) // let the lease fire
  assert.equal(calls.starts.length, 1, 'backstop should reload the model')
  assert.equal(g.isBlocked(), false, 'backstop releases the block')
})
