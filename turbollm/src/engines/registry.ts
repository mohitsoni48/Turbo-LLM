// Engine registry (A1, spec 03 §2). Pure config state; "in use" guards are
// enforced by the API layer using the Manager's live state.
import { randomUUID } from 'node:crypto'
import { ConfigStore, Engine, ValueError, findEngine } from '../config/config'
import { probe } from './probe'

export class NotFoundError extends Error {
  constructor() {
    super('engine_not_found')
    this.name = 'NotFoundError'
  }
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

  async add(name: string, binPath: string): Promise<Engine> {
    const pr = await probe(binPath)
    const eng: Engine = {
      id: randomUUID(),
      name: name.trim() || 'llama-server',
      binPath,
      kind: 'llama-server',
      version: pr.version,
      capabilities: pr.capabilities,
      addedAt: new Date().toISOString(),
    }
    this.store.update((c) => {
      c.engines.push(eng)
      if (!c.activeEngineId) c.activeEngineId = eng.id
    })
    return eng
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

  /** Best-effort fill version/capabilities for engines with none (migrated). */
  async ensureProbed(): Promise<void> {
    for (const e of this.list().engines) {
      if (e.version) continue
      try {
        await this.reprobe(e.id)
      } catch {
        /* leave unprobed; user can re-probe manually */
      }
    }
  }
}
