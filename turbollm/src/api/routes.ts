// Internal API routes (/api/v1/*) per spec 02. Thin handlers over config/engines.
import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ValueError } from '../config/config'
import type { Deps } from '../deps'
import { BusyError, type ModelInfo, type StartOpts } from '../engines/manager'
import { NotFoundError } from '../engines/registry'
import { ProbeError } from '../engines/probe'
import {
  LLAMA_BUILD,
  availableBackends,
  installedBackendServer,
  provisionBackend,
  recommendBackendId,
} from '../engines/download'
import { ensureMlxEnv } from '../engines/mlx'
import type { ModelEntry } from '../models/scanner'
import { estimateVram, type LoadProfile, profileToArgs, resolveProfile } from '../models/profile'
import { getSysInfo, primaryVendor } from '../sysinfo/sysinfo'

type Status = 200 | 201 | 202 | 400 | 401 | 404 | 409 | 500 | 503

function err(c: Context, status: Status, code: string, message: string) {
  return c.json({ error: { code, message } }, status)
}

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T
  } catch {
    return {} as T
  }
}

export function registerApi(app: Hono, d: Deps): void {
  // ---- meta ----
  app.get('/api/v1/status', (c) => {
    const ms = d.manager.status()
    const active = d.registry.active()
    const engine: Record<string, unknown> = {
      id: active?.id ?? '',
      name: active?.name ?? '',
      state: ms.state,
      port: ms.port,
      pid: ms.pid,
    }
    if (ms.err) engine.error = ms.err
    const model = ms.model
      ? { key: ms.model.key, name: ms.model.name, quant: ms.model.quant, ctx: ms.model.ctx, vision: ms.model.vision, loadElapsedMs: ms.loadElapsedMs }
      : null
    return c.json({
      version: d.version,
      engine,
      model,
      bench: { running: false },
      downloads: { active: 0 },
      engineProvision: d.provision.get(),
      telemetryLevel: d.store.snapshot().telemetry.level,
      uptimeSec: Math.floor((Date.now() - d.startedAt) / 1000),
    })
  })

  // ---- engine registry (A1) ----
  app.get('/api/v1/engines', (c) => {
    const { engines, activeEngineId } = d.registry.list()
    return c.json({ engines, activeEngineId })
  })

  // ---- engine backends (ADR-025): hardware-aware default + override ----
  app.get('/api/v1/engines/backends', (c) => {
    const sys = getSysInfo()
    const vendor = primaryVendor(sys)
    const recommended = recommendBackendId(vendor, sys.gpus.length > 0)
    const root = join(d.store.dir(), 'engines')
    const active = d.registry.active()
    const backends = availableBackends().map((b) => {
      const bin = installedBackendServer(root, b.id)
      return {
        id: b.id,
        label: b.label,
        installed: !!bin,
        recommended: b.id === recommended,
        active: !!bin && !!active && active.binPath === bin,
      }
    })
    const mlxEngine = d.registry.list().engines.find((e) => e.kind === 'mlx')
    const mlx = {
      supported: process.platform === 'darwin',
      installed: !!mlxEngine,
      active: !!mlxEngine && !!active && active.id === mlxEngine.id,
    }
    return c.json({ vendor, recommended, gpus: sys.gpus, backends, mlx })
  })

  // Provision (download if needed) + register + activate a backend. Long-running;
  // returns 202 immediately and reports progress via GET /status engineProvision.
  app.post('/api/v1/engines/backends/install', async (c) => {
    const b = await body<{ backend?: string }>(c)
    const def = availableBackends().find((x) => x.id === b.backend)
    if (!def) return err(c, 400, 'invalid_config_value', 'Unknown backend for this platform.')
    if (d.provision.get().active) return err(c, 409, 'engine_already_running', 'Another engine download is already in progress.')
    const root = join(d.store.dir(), 'engines')
    void (async () => {
      try {
        d.provision.start(def.id)
        const bin = await provisionBackend(root, def, LLAMA_BUILD, (p) =>
          d.provision.progress(p.phase, p.pct, p.part, p.parts),
        )
        let eng = d.registry.list().engines.find((e) => e.binPath === bin)
        if (!eng) eng = await d.registry.add(`llama.cpp ${LLAMA_BUILD} (${def.id})`, bin)
        d.registry.activate(eng.id)
        d.provision.done()
      } catch (e) {
        d.provision.fail(`Could not install the ${def.id} engine: ${e instanceof Error ? e.message : e}`)
      }
    })()
    return c.json({ accepted: true, backend: def.id }, 202)
  })

  // Provision the MLX engine (macOS-only, ADR-025 Phase 3): uv → venv → mlx-lm,
  // then register as a kind='mlx' engine. 202 + progress via /status.
  app.post('/api/v1/engines/mlx', (c) => {
    if (process.platform !== 'darwin') {
      return err(c, 409, 'unsupported_platform', 'MLX is only available on macOS (Apple Silicon).')
    }
    if (d.provision.get().active) return err(c, 409, 'engine_already_running', 'Another engine download is already in progress.')
    const root = join(d.store.dir(), 'engines')
    void (async () => {
      try {
        d.provision.start('mlx')
        const rt = await ensureMlxEnv(root, (p) => d.provision.progress(p.phase, p.pct, p.part, p.parts))
        const eng = d.registry.addMlx(`MLX (${rt.version})`, rt.python, rt.version)
        d.registry.activate(eng.id)
        d.provision.done()
      } catch (e) {
        d.provision.fail(`Could not install MLX: ${e instanceof Error ? e.message : e}`)
      }
    })()
    return c.json({ accepted: true, engine: 'mlx' }, 202)
  })

  app.post('/api/v1/engines', async (c) => {
    const b = await body<{ name?: string; binPath?: string }>(c)
    if (!b.binPath || !b.binPath.trim()) return err(c, 400, 'invalid_config_value', 'binPath is required.')
    try {
      const eng = await d.registry.add(b.name ?? '', b.binPath)
      return c.json(eng, 201)
    } catch (e) {
      if (e instanceof ProbeError) return err(c, 400, e.code, e.message)
      return err(c, 500, 'internal', (e as Error).message)
    }
  })

  app.put('/api/v1/engines/:id', async (c) => {
    const b = await body<{ name?: string }>(c)
    try {
      return c.json(d.registry.rename(c.req.param('id'), b.name ?? ''))
    } catch (e) {
      return regErr(c, e)
    }
  })

  app.delete('/api/v1/engines/:id', (c) => {
    const id = c.req.param('id')
    const { activeEngineId } = d.registry.list()
    if (id === activeEngineId && engineBusy(d)) {
      return err(c, 409, 'engine_in_use', 'Stop the engine before removing it.')
    }
    try {
      d.registry.remove(id)
      return c.json({ ok: true })
    } catch (e) {
      return regErr(c, e)
    }
  })

  app.post('/api/v1/engines/:id/activate', (c) => {
    if (engineBusy(d)) return err(c, 409, 'engine_running', 'Stop the running engine before switching the active engine.')
    try {
      d.registry.activate(c.req.param('id'))
      return c.json(d.registry.get(c.req.param('id')) ?? {})
    } catch (e) {
      return regErr(c, e)
    }
  })

  app.post('/api/v1/engines/:id/reprobe', async (c) => {
    try {
      return c.json(await d.registry.reprobe(c.req.param('id')))
    } catch (e) {
      if (e instanceof ProbeError) return err(c, 400, e.code, e.message)
      return regErr(c, e)
    }
  })

  // ---- lifecycle (A2) ----
  app.post('/api/v1/engine/start', async (c) => {
    const b = await body<{
      modelKey?: string
      profileOverrides?: Partial<LoadProfile>
      modelPath?: string
      extraArgs?: string[]
      modelName?: string
    }>(c)
    const active = d.registry.active()
    if (!active) return err(c, 409, 'no_active_engine', 'Register and select an engine first.')
    const cfg = d.store.snapshot()
    const sys = getSysInfo()

    // Preferred (A4): start by modelKey with a resolved LoadProfile. An empty
    // request (the Engines "Start" button) re-loads the last model.
    let key = b.modelKey ?? ''
    if (!key && !b.modelPath && cfg.lastLoaded.modelKey) key = cfg.lastLoaded.modelKey
    const entry = key ? d.scanner.get(key) : undefined

    if (entry) {
      if (entry.incomplete || entry.parseError) {
        return err(c, 409, 'model_not_loadable', 'This model is incomplete or unreadable.')
      }
      // Engine/model format must match (spec 03 §2b): MLX engines load MLX models,
      // llama.cpp engines load GGUF.
      const engineIsMlx = active.kind === 'mlx'
      if (engineIsMlx !== (entry.format === 'mlx')) {
        return err(
          c,
          409,
          'engine_model_mismatch',
          engineIsMlx
            ? 'The active engine is MLX — pick an MLX model, or switch to a llama.cpp engine for GGUF.'
            : 'This is an MLX model — activate the MLX engine to load it.',
        )
      }
      let opts: StartOpts
      if (entry.format === 'mlx') {
        // MLX: no llama.cpp LoadProfile; the model dir is the launch target.
        opts = {
          engine: active,
          model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: entry.nativeCtx, vision: false },
          modelPath: entry.path,
          extraArgs: [],
        }
      } else {
        const saved = cfg.modelProfiles[entry.key] as Partial<LoadProfile> | undefined
        const profile = resolveProfile(entry, sys, saved, b.profileOverrides)
        opts = {
          engine: active,
          model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: profile.ctx, vision: entry.vision },
          modelPath: entry.path,
          extraArgs: profileToArgs(profile, entry, active.capabilities),
        }
      }
      await d.manager.stopAndWait()
      try {
        await d.manager.start(opts)
      } catch (e) {
        return startError(c, e)
      }
      d.store.update((x) => {
        x.lastLoaded = { modelKey: entry.key, engineId: active.id }
      })
      return c.json({ ok: true }, 202)
    }

    // Transitional fallback: explicit path or migrated devModel (pre-A4 configs).
    let modelPath = b.modelPath ?? ''
    let extra = b.extraArgs ?? []
    let name = b.modelName ?? ''
    if (!modelPath && cfg.devModel) {
      modelPath = cfg.devModel.modelPath
      extra = cfg.devModel.extraArgs
      name = cfg.devModel.label
    }
    if (!modelPath) return err(c, 409, 'no_such_model', 'No model specified. Pick one from the Models screen.')
    const opts: StartOpts = { engine: active, model: deriveModel(modelPath, name, extra), modelPath, extraArgs: extra }
    await d.manager.stopAndWait()
    try {
      await d.manager.start(opts)
    } catch (e) {
      return startError(c, e)
    }
    return c.json({ ok: true }, 202)
  })

  app.post('/api/v1/engine/stop', (c) => {
    d.manager.stop()
    return c.json({ ok: true }, 202)
  })

  app.post('/api/v1/engine/restart', (c) => {
    void d.manager.restart().catch(() => {})
    return c.json({ ok: true }, 202)
  })

  app.get('/api/v1/engine/logs', (c) => {
    const tail = Math.min(Number(c.req.query('tail')) || 200, 2000)
    return c.json({ lines: readTail(d.manager.logPath(), tail) })
  })

  app.get('/api/v1/engine/logs/stream', (c) =>
    streamSSE(c, async (stream) => {
      let sent = 0
      let aborted = false
      let ticks = 0
      stream.onAbort(() => {
        aborted = true
      })
      while (!aborted) {
        const path = d.manager.logPath()
        if (path && existsSync(path)) {
          const lines = readFileSync(path, 'utf8').split('\n')
          for (; sent < lines.length - 1; sent++) {
            await stream.writeSSE({ event: 'line', data: JSON.stringify({ line: lines[sent].replace(/\r$/, '') }) })
          }
        }
        if (++ticks % 37 === 0) await stream.writeSSE({ data: '', event: 'ping' })
        await stream.sleep(400)
      }
    }),
  )

  // ---- models (A3, spec 04) ----
  app.get('/api/v1/models', (c) => {
    const { models, scanning, lastScanAt } = d.scanner.list()
    return c.json({ models: models.map((m) => overlayModel(m, d)), scanning, lastScanAt })
  })

  app.post('/api/v1/models/rescan', (c) => {
    void d.scanner.rescan()
    return c.json({ ok: true }, 202)
  })

  app.get('/api/v1/models/:key', (c) => {
    const e = d.scanner.get(decodeURIComponent(c.req.param('key')))
    if (!e) return err(c, 404, 'no_such_model', 'No model with that key.')
    const sys = getSysInfo()
    const saved = d.store.snapshot().modelProfiles[e.key] as Partial<LoadProfile> | undefined
    const profile = resolveProfile(e, sys, saved)
    return c.json({ ...overlayModel(e, d), profile, vramFit: estimateVram(profile, e, sys), gpu: sys.gpus[0] ?? null })
  })

  app.put('/api/v1/models/:key/profile', async (c) => {
    const key = decodeURIComponent(c.req.param('key'))
    const e = d.scanner.get(key)
    if (!e) return err(c, 404, 'no_such_model', 'No model with that key.')
    const p = await body<LoadProfile>(c)
    if (!p || typeof p.ctx !== 'number' || p.ctx < 256) {
      return err(c, 400, 'invalid_profile_value', 'ctx must be at least 256.')
    }
    d.store.update((cfg) => {
      cfg.modelProfiles[key] = p as unknown as Record<string, unknown>
    })
    return c.json(p)
  })

  app.post('/api/v1/models/:key/profile/reset', (c) => {
    const key = decodeURIComponent(c.req.param('key'))
    d.store.update((cfg) => {
      delete cfg.modelProfiles[key]
    })
    return c.json({ ok: true })
  })

  app.get('/api/v1/sysinfo', (c) => c.json(getSysInfo()))

  // ---- model directories (spec 02 §5) ----
  app.get('/api/v1/modeldirs', (c) => c.json({ dirs: d.store.snapshot().modelDirs }))

  app.post('/api/v1/modeldirs', async (c) => {
    const b = await body<{ dir?: string }>(c)
    const dir = (b.dir ?? '').trim()
    if (!dir || !/^([a-zA-Z]:[\\/]|[\\/])/.test(dir)) return err(c, 400, 'invalid_config_value', 'Path must be absolute.')
    if (!existsSync(dir)) return err(c, 400, 'invalid_config_value', 'That folder does not exist.')
    try {
      d.store.update((cfg) => {
        if (!cfg.modelDirs.includes(dir)) cfg.modelDirs.push(dir)
      })
    } catch (e) {
      return regErr(c, e)
    }
    void d.scanner.rescan()
    return c.json({ dirs: d.store.snapshot().modelDirs }, 201)
  })

  app.delete('/api/v1/modeldirs', async (c) => {
    const b = await body<{ dir?: string }>(c)
    d.store.update((cfg) => {
      cfg.modelDirs = cfg.modelDirs.filter((x) => x !== b.dir)
    })
    void d.scanner.rescan()
    return c.json({ dirs: d.store.snapshot().modelDirs })
  })
}

/** Overlay the live-dynamic flags (loaded, hasProfile) onto a scanned entry. */
function overlayModel(e: ModelEntry, d: Deps) {
  const ms = d.manager.status()
  const loadedKey = ms.state === 'running' ? ms.model?.key : undefined
  const profiles = d.store.snapshot().modelProfiles
  return { ...e, loaded: loadedKey === e.path || loadedKey === e.key, hasProfile: e.key in profiles }
}

// ---- helpers ----

function engineBusy(d: Deps): boolean {
  const s = d.manager.status().state
  return s === 'running' || s === 'starting' || s === 'stopping'
}

function regErr(c: Context, e: unknown) {
  if (e instanceof NotFoundError) return err(c, 404, 'engine_not_found', 'No engine with that id.')
  if (e instanceof ValueError) return err(c, 400, 'invalid_config_value', e.message)
  return err(c, 500, 'internal', (e as Error).message)
}

function startError(c: Context, e: unknown) {
  if (e instanceof BusyError) return err(c, 409, 'engine_already_running', 'An engine is already running.')
  if ((e as Error).message === 'no_free_port') return err(c, 409, 'no_free_port', 'No free port for the engine (8081–8181 all in use).')
  return err(c, 500, 'engine_start_failed', (e as Error).message)
}

function deriveModel(modelPath: string, name: string, extraArgs: string[]): ModelInfo {
  let ctx = 0
  for (let i = 0; i + 1 < extraArgs.length; i++) {
    if (extraArgs[i] === '-c' || extraArgs[i] === '--ctx-size') ctx = Number(extraArgs[i + 1]) || 0
  }
  return { key: modelPath, name: name || cleanModelName(modelPath), quant: '', ctx, vision: false }
}

function cleanModelName(p: string): string {
  return basename(p).replace(/\.gguf$/i, '')
}

function readTail(path: string, n: number): string[] {
  if (!path || !existsSync(path)) return []
  try {
    const lines = readFileSync(path, 'utf8').replace(/[\r\n]+$/, '').split('\n').map((l) => l.replace(/\r$/, ''))
    return lines.length > n ? lines.slice(-n) : lines
  } catch {
    return []
  }
}
