// Rollback-safe update application (ADR-085, Phase 6, Layer 2). One orchestrator that
// updates an engine to the real latest upstream, dispatched by its update source:
//   - official llama.cpp  → download the latest tag into a NEW tag-keyed dir, probe it,
//                           and only on success register + activate it and GC the old dir;
//                           on any failure the old install is left untouched (rollback).
//   - TurboQuant fork     → re-provision the fork's latest GitHub release (replace dir).
//   - vLLM / MLX (pip)    → `uv pip install -U/--upgrade` into the existing venv.
//
// Shared by the HTTP update endpoints AND the auto-update scheduler so both take the
// exact same honest, rollback-safe path. Keeps the pure decision logic (update.ts)
// separate from this I/O-heavy orchestration.

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigStore, Engine } from '../config/config'
import type { Manager } from './manager'
import type { ProvisionState } from './provision-state'
import type { Registry } from './registry'
import {
  type BackendId,
  backendDefAt,
  backendDir,
  latestReleaseTag,
  provisionBackend,
  provisionForkRelease,
} from './download'
import { ensureMlxEnv } from './mlx'
import { ensureVllmEnv } from './vllm'
import { tagFromManagedBinPath } from './update'

export interface UpdateApplyDeps {
  store: ConfigStore
  registry: Registry
  manager: Manager
  provision: ProvisionState
}

const OFFICIAL_LLAMA_REPO = 'ggml-org/llama.cpp'
const isManagedLlama = (binPath: string) => /[\\/]engines[\\/]llama\.cpp-/.test(binPath)
const isTurboquant = (binPath: string) => /[\\/]engines[\\/]turboquant[\\/]/.test(binPath)

/** Apply a rollback-safe update for one engine. Throws on failure (callers surface it);
 *  on the llama.cpp path the existing install is guaranteed untouched when it throws. */
export async function applyEngineUpdate(d: UpdateApplyDeps, engine: Engine, signal?: AbortSignal): Promise<void> {
  const root = join(d.store.dir(), 'engines')
  if (engine.kind === 'mlx') return applyPipUpdate(d, 'mlx', engine, root)
  if (engine.kind === 'vllm') return applyPipUpdate(d, 'vllm', engine, root)
  if (engine.kind === 'llama-server') {
    if (isManagedLlama(engine.binPath)) return applyLlamaCppUpdate(d, engine, root, signal)
    if (isTurboquant(engine.binPath)) return applyForkUpdate(d, engine, root, signal)
  }
  throw new Error('This engine has no automatic update source.')
}

/** Official llama.cpp: download the real latest tag into its own dir, probe, then swap
 *  + GC the old. The old dir is only deleted AFTER the new one probes successfully. */
async function applyLlamaCppUpdate(d: UpdateApplyDeps, engine: Engine, root: string, signal?: AbortSignal): Promise<void> {
  const backendId = backendIdOf(engine.binPath)
  if (!backendId) throw new Error('Could not determine the GPU backend of this build.')
  const installedTag = tagFromManagedBinPath(engine.binPath)
  const latestTag = await latestReleaseTag(OFFICIAL_LLAMA_REPO, signal)
  if (!latestTag) throw new Error('GitHub did not report a latest build.')
  if (installedTag && installedTag === latestTag) return // already latest — nothing to do
  const newDef = backendDefAt(backendId, latestTag)
  if (!newDef) throw new Error('No upstream build of this backend for your platform.')

  d.provision.start(backendId)
  try {
    const newBin = await provisionBackend(
      root, newDef, latestTag,
      (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts),
      signal,
    )
    let newEng = d.registry.list().engines.find((e) => e.binPath === newBin)
    if (!newEng) newEng = (await d.registry.add(`llama.cpp ${latestTag} (${backendId})`, newBin)).engine
    // Stop the running engine only if it's the OLD build of this backend.
    const oldEng = d.registry.list().engines.find((e) => e.binPath === engine.binPath)
    if (oldEng && d.registry.active()?.id === oldEng.id) await d.manager.stopAndWait()
    d.registry.activate(newEng.id)
    if (oldEng && oldEng.id !== newEng.id) {
      try { d.registry.remove(oldEng.id) } catch { /* already gone */ }
    }
    if (installedTag && installedTag !== latestTag) {
      rmSync(backendDir(root, backendId, installedTag), { recursive: true, force: true })
    }
    d.provision.done()
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') d.provision.done()
    else d.provision.fail(`Could not update llama.cpp (${backendId}) — your existing build is unchanged: ${msg(e)}`)
    throw e
  }
}

/** TurboQuant fork: remove the install dir + re-provision the fork's latest release. */
async function applyForkUpdate(d: UpdateApplyDeps, engine: Engine, root: string, signal?: AbortSignal): Promise<void> {
  d.provision.start('turboquant')
  try {
    const oldEng = d.registry.list().engines.find((e) => e.binPath === engine.binPath)
    if (oldEng && d.registry.active()?.id === oldEng.id) await d.manager.stopAndWait()
    const tqDir = join(root, 'turboquant')
    rmSync(tqDir, { recursive: true, force: true })
    const bin = await provisionForkRelease(
      root, 'AtomicBot-ai/atomic-llama-cpp-turboquant', 'turboquant',
      (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts),
      signal,
    )
    let eng = d.registry.list().engines.find((e) => e.binPath === bin)
    if (!eng) eng = (await d.registry.add('TurboQuant', bin)).engine
    d.registry.activate(eng.id)
    d.provision.done()
  } catch (e) {
    d.provision.fail(`Could not update TurboQuant: ${msg(e)}`)
    throw e
  }
}

/** vLLM / MLX: upgrade the package in place (uv pip install -U/--upgrade). */
async function applyPipUpdate(d: UpdateApplyDeps, kind: 'mlx' | 'vllm', engine: Engine, root: string): Promise<void> {
  d.provision.start(kind)
  try {
    if (d.registry.active()?.id === engine.id) await d.manager.stopAndWait()
    if (kind === 'mlx') {
      const rt = await ensureMlxEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), true)
      const eng = d.registry.addMlx(`MLX (${rt.version})`, rt.python, rt.version)
      d.registry.activate(eng.id)
    } else {
      const rt = await ensureVllmEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts), true)
      const eng = d.registry.addVllm(`vLLM (${rt.version})`, rt.python, rt.version)
      d.registry.activate(eng.id)
    }
    d.provision.done()
  } catch (e) {
    d.provision.fail(`Could not update ${kind === 'mlx' ? 'MLX' : 'vLLM'}: ${msg(e)}`)
    throw e
  }
}

function backendIdOf(binPath: string): BackendId | null {
  const m = /[\\/]engines[\\/]llama\.cpp-[^\\/]+?-(cuda|rocm|sycl|vulkan|metal|cpu)[\\/]/.exec(binPath)
  return m ? (m[1] as BackendId) : null
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
