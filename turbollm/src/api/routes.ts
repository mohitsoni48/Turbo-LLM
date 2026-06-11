// Internal API routes (/api/v1/*) per spec 02. Thin handlers over config/engines.
import type { Context, Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { ValueError } from '../config/config'
import type { Deps } from '../deps'
import { BusyError, type ModelInfo, type StartOpts } from '../engines/manager'
import { NotFoundError } from '../engines/registry'
import { ProbeError } from '../engines/probe'
import type { ModelEntry } from '../models/scanner'

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
      telemetryLevel: d.store.snapshot().telemetry.level,
      uptimeSec: Math.floor((Date.now() - d.startedAt) / 1000),
    })
  })

  app.get('/api/v1/sysinfo', (c) => c.json({ os: '', cpu: '', ramMB: 0, gpus: [] }))

  // ---- engine registry (A1) ----
  app.get('/api/v1/engines', (c) => {
    const { engines, activeEngineId } = d.registry.list()
    return c.json({ engines, activeEngineId })
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
    // Transitional body (A1/A2): explicit model path + args, else migrated devModel.
    const b = await body<{ modelPath?: string; extraArgs?: string[]; modelName?: string }>(c)
    const active = d.registry.active()
    if (!active) return err(c, 409, 'no_active_engine', 'Register and select an engine first.')
    const cfg = d.store.snapshot()
    let modelPath = b.modelPath ?? ''
    let extra = b.extraArgs ?? []
    let name = b.modelName ?? ''
    if (!modelPath && cfg.devModel) {
      modelPath = cfg.devModel.modelPath
      extra = cfg.devModel.extraArgs
      name = cfg.devModel.label
    }
    if (!modelPath) return err(c, 409, 'no_such_model', 'No model specified and no default model configured.')
    const opts: StartOpts = { engine: active, model: deriveModel(modelPath, name, extra), modelPath, extraArgs: extra }
    try {
      await d.manager.start(opts)
      return c.json({ ok: true }, 202)
    } catch (e) {
      if (e instanceof BusyError) return err(c, 409, 'engine_already_running', 'An engine is already running.')
      if ((e as Error).message === 'no_free_port') return err(c, 409, 'no_free_port', 'No free port for the engine (8081–8181 all in use).')
      return err(c, 500, 'engine_start_failed', (e as Error).message)
    }
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
    return c.json(overlayModel(e, d))
  })

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
