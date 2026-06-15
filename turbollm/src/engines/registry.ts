// Engine registry (A1, spec 03 §2). Pure config state; "in use" guards are
// enforced by the API layer using the Manager's live state.
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ConfigStore, Engine, ValueError, findEngine } from '../config/config'
import { probe } from './probe'

/** Auto-provisioned official builds live under `<dataDir>/engines/llama.cpp-…/`.
 *  User forks are arbitrary paths and are never auto-removed. */
const isManagedBuild = (binPath: string) => /[\\/]engines[\\/]llama\.cpp-/.test(binPath)

export class NotFoundError extends Error {
  constructor() {
    super('engine_not_found')
    this.name = 'NotFoundError'
  }
}

/** Thrown by add()/addMlx() when another engine already uses the given name
 *  (case-insensitive, trimmed). Mapped to a 400 `name_already_taken` (spec 03 §2). */
export class NameTakenError extends Error {
  constructor() {
    super('Name already in use — choose a different name.')
    this.name = 'NameTakenError'
  }
}

/** add() returns the saved engine plus a non-blocking warning when the probe ran
 *  but could not extract a version (`probe_no_version`, spec 03 §2/§9). The engine
 *  is still saved; the UI surfaces the warning. */
export interface AddResult {
  engine: Engine
  warning?: 'no_version'
}

export class Registry {
  constructor(private store: ConfigStore) {}

  list(): { engines: Engine[]; activeEngineId: string } {
    const c = this.store.snapshot()
    return { engines: c.engines, activeEngineId: c.activeEngineId }
  }

  get(id: string): Engine | undefined {
    return findEngine(this.store.snapshot().engines, id)
  }

  active(): Engine | undefined {
    const c = this.store.snapshot()
    return c.activeEngineId ? findEngine(c.engines, c.activeEngineId) : undefined
  }

  async add(name: string, binPath: string): Promise<AddResult> {
    const finalName = name.trim() || 'llama-server'
    this.assertNameFree(finalName)
    const pr = await probe(binPath)
    const eng: Engine = {
      id: randomUUID(),
      name: finalName,
      binPath,
      kind: 'llama-server',
      version: pr.version,
      capabilities: pr.capabilities,
      addedAt: new Date().toISOString(),
    }
    this.store.update((c) => {
      // Re-check under the store lock — the name could have been taken between the
      // pre-probe check and now (a probe can take up to 10s).
      if (this.nameClash(c.engines, finalName)) throw new NameTakenError()
      c.engines.push(eng)
      if (!c.activeEngineId) c.activeEngineId = eng.id
    })
    return { engine: eng, warning: pr.version === 'unknown' ? 'no_version' : undefined }
  }

  /** True if any registered engine already uses `name` (case-insensitive, trimmed). */
  private nameClash(engines: Engine[], name: string): boolean {
    const n = name.trim().toLowerCase()
    return engines.some((e) => e.name.trim().toLowerCase() === n)
  }

  private assertNameFree(name: string): void {
    if (this.nameClash(this.store.snapshot().engines, name)) throw new NameTakenError()
  }

  /** Register an MLX engine (kind='mlx'). No llama-server probe — the binPath is
   *  a venv python, not a llama-server, so capabilities/flags don't apply. */
  addMlx(name: string, binPath: string, version: string): Engine {
    const eng: Engine = {
      id: randomUUID(),
      name: name.trim() || 'MLX',
      binPath,
      kind: 'mlx',
      version,
      capabilities: { kvTypes: [], flags: [] },
      addedAt: new Date().toISOString(),
    }
    this.store.update((c) => {
      // Replace an existing MLX engine at the same path rather than duplicating.
      const existing = c.engines.find((e) => e.kind === 'mlx' && e.binPath === binPath)
      if (existing) {
        existing.version = version
        eng.id = existing.id
      } else {
        c.engines.push(eng)
      }
      if (!c.activeEngineId) c.activeEngineId = eng.id
    })
    return eng
  }

  /** Register a vLLM engine (kind='vllm'). Like addMlx, the binPath is a venv
   *  python (not a llama-server), so llama.cpp capabilities/flags don't apply. */
  addVllm(name: string, binPath: string, version: string): Engine {
    const eng: Engine = {
      id: randomUUID(),
      name: name.trim() || 'vLLM',
      binPath,
      kind: 'vllm',
      version,
      capabilities: { kvTypes: [], flags: [] },
      addedAt: new Date().toISOString(),
    }
    this.store.update((c) => {
      // Replace an existing vLLM engine at the same path rather than duplicating.
      const existing = c.engines.find((e) => e.kind === 'vllm' && e.binPath === binPath)
      if (existing) {
        existing.version = version
        eng.id = existing.id
      } else {
        c.engines.push(eng)
      }
      if (!c.activeEngineId) c.activeEngineId = eng.id
    })
    return eng
  }

  rename(id: string, name: string): Engine {
    let out: Engine | undefined
    this.store.update((c) => {
      const e = findEngine(c.engines, id)
      if (!e) throw new NotFoundError()
      const n = name.trim()
      if (!n) throw new ValueError('name', 'name cannot be empty')
      e.name = n
      out = structuredClone(e)
    })
    return out!
  }

  remove(id: string): void {
    this.store.update((c) => {
      const i = c.engines.findIndex((e) => e.id === id)
      if (i < 0) throw new NotFoundError()
      c.engines.splice(i, 1)
      if (c.activeEngineId === id) c.activeEngineId = c.engines[0]?.id ?? ''
    })
  }

  activate(id: string): void {
    this.store.update((c) => {
      if (!findEngine(c.engines, id)) throw new NotFoundError()
      c.activeEngineId = id
    })
  }

  async reprobe(id: string): Promise<Engine> {
    const e = this.get(id)
    if (!e) throw new NotFoundError()
    const pr = await probe(e.binPath)
    let out: Engine | undefined
    this.store.update((c) => {
      const ce = findEngine(c.engines, id)
      if (!ce) throw new NotFoundError()
      ce.version = pr.version
      ce.capabilities = pr.capabilities
      out = structuredClone(ce)
    })
    return out!
  }

  /** Drop registry entries for managed official builds whose binary no longer
   *  exists — e.g. a duplicate left dangling after the data dir moved (ADR-030),
   *  or a backend folder the user deleted by hand. User forks are left untouched
   *  (their binary may be temporarily unavailable). Returns the count removed. */
  pruneDeadManagedBuilds(): number {
    let removed = 0
    for (const e of this.list().engines) {
      if (isManagedBuild(e.binPath) && !existsSync(e.binPath)) {
        try {
          this.remove(e.id)
          removed++
        } catch {
          /* ignore */
        }
      }
    }
    return removed
  }

  /** Best-effort fill version/capabilities for engines with none (migrated), and
   *  refresh engines probed by an older daemon that predates a capability field —
   *  e.g. one with `--spec-type` but no captured `spec-type:<value>` entries, so
   *  NextN/MTP gating has the data it needs without a manual re-probe. */
  async ensureProbed(): Promise<void> {
    const stale = (e: Engine) =>
      e.capabilities.flags.includes('--spec-type') &&
      !e.capabilities.flags.some((f) => f.startsWith('spec-type:'))
    for (const e of this.list().engines) {
      if (e.version && !stale(e)) continue
      try {
        await this.reprobe(e.id)
      } catch {
        /* leave as-is; user can re-probe manually */
      }
    }
  }
}
