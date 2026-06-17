// Engine lifecycle state machine (A2, spec 03 §4): stopped → starting → running
// → stopping → stopped, plus error. Owns the single running engine process.
// Ports the verified Go manager to node:child_process.
import { ChildProcess, execFile, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import type { ConfigStore, Engine } from '../config/config'
import { mlxServerCommand } from './mlx'
import { slotCacheDir } from './slot-cache'
import { vllmServerCommand } from './vllm'

export type State = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export interface ModelInfo {
  key: string
  name: string
  quant: string
  ctx: number
  vision: boolean
}
export interface ErrInfo {
  code: string
  message: string
  exitCode: number
  logTail: string[]
}
export interface StartOpts {
  engine: Engine
  model: ModelInfo
  modelPath: string
  extraArgs: string[]
  /** vLLM multi-GPU shard count (ADR-054). Only consumed by the vllm branch of
   *  {@link engineCommand}; llama.cpp carries its GPU flags in extraArgs instead. */
  tensorParallelSize?: number
}
export interface Status {
  state: State
  err: ErrInfo | null
  port: number
  pid: number
  model: ModelInfo | null
  loadElapsedMs: number
}

/** Per-completion numbers fed into the running-session accumulator (B4). All
 *  fields are best-effort: a path that can't compute t/s simply omits it. */
export interface CompletionRecord {
  inputTokens?: number
  outputTokens?: number
  promptTps?: number
  genTps?: number
}

/** Live per-request progress for the engine card (spec 11). `phase` is the current
 *  stage of the most-recent in-flight completion; cleared once nothing is generating. */
export interface LiveGen {
  phase: 'prompt' | 'gen'
  /** Prompt-processing percent (0–100) while `phase === 'prompt'`; 0 in gen phase. */
  pct: number
  /** Output tokens produced so far in the gen phase (live, approximate). */
  outputTokens: number
}

/** Live summary of the current running session (B4). Resets on start/stop. */
export interface SessionStats {
  requests: number
  inputTokens: number
  outputTokens: number
  avgPromptTps: number
  avgGenTps: number
  sinceMs: number
  /** Number of completions currently streaming through the engine right now. >0
   *  drives the "Generating…" live indicator in the engine card. */
  activeRequests: number
}

interface SessionAccumulator {
  requests: number
  inputTokens: number
  outputTokens: number
  sumPromptTps: number
  sumGenTps: number
  promptTpsCount: number
  genTpsCount: number
  startedAt: number
}

function freshSession(): SessionAccumulator {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    sumPromptTps: 0,
    sumGenTps: 0,
    promptTpsCount: 0,
    genTpsCount: 0,
    startedAt: Date.now(),
  }
}

function posNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

export class BusyError extends Error {
  constructor() {
    super('engine_already_running')
    this.name = 'BusyError'
  }
}

export class Manager {
  private state: State = 'stopped'
  private opts: StartOpts | null = null
  private port = 0
  private pid = 0
  private child: ChildProcess | null = null
  private startedAt = 0
  private errInfo: ErrInfo | null = null
  private lastActivity = 0
  private logPathStr = ''
  private exited: Promise<void> = Promise.resolve()
  private resolveExited: (() => void) | null = null
  private generation = 0
  private liveGen: LiveGen | null = null
  private session: SessionAccumulator = freshSession()

  constructor(private store: ConfigStore) {
    setInterval(() => this.watchdogTick(), 60_000).unref()
  }

  async start(opts: StartOpts): Promise<void> {
    if (this.state === 'starting' || this.state === 'running' || this.state === 'stopping') {
      throw new BusyError()
    }
    if (!opts.engine.binPath) throw new Error('no_active_engine')
    if (!opts.modelPath) throw new Error('no_such_model')

    const port = await allocPort()
    const logPath = join(this.store.dir(), 'logs', `engine-${opts.engine.id}.log`)
    mkdirSync(dirname(logPath), { recursive: true })
    const logStream = createWriteStream(logPath) // truncates
    // Header so the raw engine log is self-explanatory. `port` is the engine's OWN
    // loopback port (allocated 8081+), DISTINCT from the TurboLLM app/UI port the
    // user configures — surfacing it here stops the "it says 8081 even though I
    // changed the port" confusion, since this log is what the user reads.
    logStream.write(
      `[turbollm] starting engine "${opts.engine.name}" on internal port ${port} ` +
        `(127.0.0.1 only — the engine's own port, NOT the TurboLLM app/UI port).\n`,
    )

    // KV prompt-cache persistence (F-014): when ComfyUI coordination + the opt-in are on
    // and this is a llama.cpp engine whose caps allow the flag, point llama-server at the
    // slot-cache dir via `--slot-save-path`. That arms the slot save/restore endpoints the
    // ComfyUI guard uses to persist the prompt cache across a forced unload/reload. Not
    // passed for mlx/vllm (no cross-restart slot persistence). The dir must exist first.
    const cfg = this.store.snapshot()
    let slotSavePath: string | undefined
    if (cfg.comfyui.enabled && cfg.comfyui.cachePersist && opts.engine.kind === 'llama-server') {
      const flags = opts.engine.capabilities.flags
      if (flags.length === 0 || flags.includes('--slot-save-path')) {
        slotSavePath = slotCacheDir(this.store.dir())
        mkdirSync(slotSavePath, { recursive: true })
      }
    }

    const { cmd, args } = engineCommand(opts, port, slotSavePath)
    const child = spawn(cmd, args, { cwd: dirname(cmd), windowsHide: true, env: pyEngineEnv(opts.engine.kind, this.store.dir()) })
    // end:false — otherwise whichever of stdout/stderr closes first would end the
    // shared log stream and drop the other's output. We close it in onTerminated.
    child.stdout?.pipe(logStream, { end: false })
    child.stderr?.pipe(logStream, { end: false })

    this.state = 'starting'
    this.session = freshSession() // each running session starts with fresh stats (B4)
    this.opts = opts
    this.port = port
    this.pid = child.pid ?? 0
    this.child = child
    this.startedAt = Date.now()
    this.errInfo = null
    this.lastActivity = Date.now()
    this.logPathStr = logPath
    this.exited = new Promise<void>((res) => {
      this.resolveExited = res
    })

    child.on('error', (e) => this.onTerminated(child, -1, logStream, e.message))
    child.on('close', (code) => this.onTerminated(child, code ?? -1, logStream, null))
    void this.readiness(child, port)
  }

  stop(): void {
    if (this.state === 'error') {
      this.state = 'stopped'
      this.errInfo = null
    }
    const child = this.child
    if (!child || (this.state !== 'running' && this.state !== 'starting')) return
    this.state = 'stopping'
    void gracefulStop(child, this.exited)
  }

  /** Kill the engine immediately (SIGKILL / taskkill /F) to free VRAM without the
   *  graceful grace period. The `close` handler still runs and resolves `exited`. */
  private forceStop(): void {
    const child = this.child
    if (!child || (this.state !== 'running' && this.state !== 'starting')) return
    this.state = 'stopping'
    forceKill(child)
  }

  async stopAndWait(opts?: { force?: boolean }): Promise<void> {
    const exited = this.exited
    if (this.state === 'running' || this.state === 'starting') {
      // force: SIGKILL immediately rather than the graceful TERM→8s-then-kill path.
      // Used by the ComfyUI guard, which needs the VRAM freed NOW before ComfyUI runs.
      if (opts?.force) this.forceStop()
      else this.stop()
      await Promise.race([exited, sleep(10_000)])
    } else if (this.state === 'stopping') {
      await Promise.race([exited, sleep(10_000)])
    } else if (this.state === 'error') {
      this.state = 'stopped'
      this.errInfo = null
    }
  }

  async restart(): Promise<void> {
    const opts = this.opts
    const running = this.state === 'running' || this.state === 'starting'
    const exited = this.exited
    if (!opts?.modelPath) throw new Error('no_such_model')
    if (running) {
      this.stop()
      await Promise.race([exited, sleep(10_000)])
    }
    await this.start(opts)
  }

  status(): Status {
    const st: Status = { state: this.state, err: this.errInfo, port: this.port, pid: this.pid, model: null, loadElapsedMs: 0 }
    if ((this.state === 'running' || this.state === 'starting') && this.opts) {
      st.model = this.opts.model
      if (this.state === 'starting') st.loadElapsedMs = Date.now() - this.startedAt
    }
    return st
  }

  target(): string | null {
    return this.state === 'running' ? `http://127.0.0.1:${this.port}` : null
  }

  /** The StartOpts of the currently loaded (or loading) model, or null when nothing
   *  is up. Lets an external coordinator (the ComfyUI guard) snapshot what to reload
   *  after it has unloaded the model to free the GPU. */
  currentOpts(): StartOpts | null {
    return (this.state === 'running' || this.state === 'starting') ? this.opts : null
  }

  touch(): void {
    this.lastActivity = Date.now()
  }

  /** Record a completed completion into the running-session accumulator (B4).
   *  Fully fail-safe: callers wrap this in try/catch too, but every field is
   *  individually guarded so a bad number can never corrupt the totals. */
  recordCompletion(rec: CompletionRecord): void {
    const s = this.session
    s.requests += 1
    s.inputTokens += posNum(rec.inputTokens)
    s.outputTokens += posNum(rec.outputTokens)
    const pt = posNum(rec.promptTps)
    if (pt > 0) {
      s.sumPromptTps += pt
      s.promptTpsCount += 1
    }
    const gt = posNum(rec.genTps)
    if (gt > 0) {
      s.sumGenTps += gt
      s.genTpsCount += 1
    }
  }

  /** Computed snapshot of the current running session's stats (B4). */
  sessionStats(): SessionStats {
    const s = this.session
    return {
      requests: s.requests,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      avgPromptTps: s.promptTpsCount > 0 ? s.sumPromptTps / s.promptTpsCount : 0,
      avgGenTps: s.genTpsCount > 0 ? s.sumGenTps / s.genTpsCount : 0,
      sinceMs: Date.now() - s.startedAt,
      activeRequests: this.generation,
    }
  }
  logPath(): string {
    return this.logPathStr
  }
  generationStart(): void {
    this.generation++
  }
  generationEnd(): void {
    this.generation = Math.max(0, this.generation - 1)
    if (this.generation === 0) this.liveGen = null
  }

  /** Publish live progress for the in-flight completion (cheap; called per chunk).
   *  Last-writer-wins — a single slot is enough for the single-model engine card. */
  setLiveGen(g: LiveGen): void {
    this.liveGen = g
  }

  /** Live progress for the engine card, or null when nothing is generating. */
  liveGeneration(): LiveGen | null {
    return this.generation > 0 ? this.liveGen : null
  }

  async shutdown(): Promise<void> {
    const child = this.child
    const running = this.state === 'running' || this.state === 'starting'
    if (!child || !running) return
    this.state = 'stopping'
    await gracefulStop(child, this.exited)
  }

  // ---- internal ----------------------------------------------------------

  private onTerminated(child: ChildProcess, code: number, logStream: NodeJS.WritableStream, errMsg: string | null): void {
    if (this.child !== child) return
    // Terminal marker so the live engine log can't keep "looking connected" after
    // the process dies. Without it the last line stays "...server is listening on
    // <port>" forever, contradicting the Error state shown above it (the reported bug).
    const cleanStop = this.state === 'stopping' || this.state === 'stopped'
    try {
      logStream.write(
        cleanStop
          ? `\n[turbollm] engine stopped — the model is no longer loaded.\n`
          : `\n[turbollm] engine process exited unexpectedly (exit ${code})` +
              `${errMsg ? ` — ${errMsg}` : ''}. The model did NOT load / is no longer loaded.\n`,
      )
    } catch {
      /* best-effort marker */
    }
    logStream.end()
    if (this.state === 'stopping' || this.state === 'stopped') {
      this.state = 'stopped'
    } else {
      this.state = 'error'
      this.errInfo = {
        code: errMsg ? 'engine_spawn_failed' : 'engine_exited',
        message: errMsg ?? 'The engine process exited unexpectedly.',
        exitCode: code,
        logTail: readTail(this.logPathStr, 20),
      }
    }
    this.child = null
    this.pid = 0
    this.session = freshSession() // session ended — clear stats (B4)
    this.resolveExited?.()
  }

  private async readiness(child: ChildProcess, port: number): Promise<void> {
    const kind = this.opts?.engine.kind ?? 'llama-server'
    const deadline = Date.now() + readinessTimeoutMs(kind)
    for (;;) {
      await sleep(500)
      if (this.child !== child || this.state !== 'starting') return
      // Python engines (mlx/vllm) load the model in a background thread AFTER the HTTP
      // socket binds, so /v1/models answers 200 even when the load crashed — which would
      // otherwise flip us to "running" and then hang every request forever on a dead
      // generation thread. Detect a fatal load-failure traceback in the log and surface
      // it as an engine error instead. (Checked before probeReady so we win the race.)
      if (kind === 'mlx' || kind === 'vllm') {
        const loadErr = detectPyLoadFailure(readTail(this.logPathStr, 200))
        if (loadErr) {
          if (this.child === child && this.state === 'starting') {
            this.state = 'error'
            this.errInfo = { code: 'model_load_failed', message: loadErr, exitCode: -1, logTail: readTail(this.logPathStr, 20) }
            child.kill('SIGKILL')
          }
          return
        }
      }
      if (await probeReady(port)) {
        if (this.child === child && this.state === 'starting') {
          this.state = 'running'
          this.lastActivity = Date.now()
        }
        return
      }
      if (Date.now() > deadline) {
        if (this.child === child && this.state === 'starting') {
          this.state = 'error'
          this.errInfo = {
            code: 'readiness_timeout',
            message: `The model did not become ready within ${Math.round(readinessTimeoutMs(this.opts?.engine.kind ?? 'llama-server') / 1000)} seconds.`,
            exitCode: -1,
            logTail: readTail(this.logPathStr, 20),
          }
          child.kill('SIGKILL')
        }
        return
      }
    }
  }

  private watchdogTick(): void {
    const ttl = this.store.snapshot().daemon.idleTtlMinutes
    if (ttl <= 0) return
    const idle = this.state === 'running' && Date.now() - this.lastActivity > ttl * 60_000 && this.generation === 0
    if (idle) this.stop()
  }
}

// ---- helpers ---------------------------------------------------------------

/** Build the spawn command for an engine, branching on its kind (spec 03 §2b).
 *  `slotSavePath` (F-014) is appended only for llama.cpp; mlx/vllm don't support it. */
function engineCommand(opts: StartOpts, port: number, slotSavePath?: string): { cmd: string; args: string[] } {
  if (opts.engine.kind === 'mlx') {
    // MLX: run the mlx-lm OpenAI server via the provisioned venv python. The
    // llama.cpp LoadProfile flags in opts.extraArgs do not apply and are dropped.
    return mlxServerCommand(opts.engine.binPath, opts.modelPath, port, '127.0.0.1')
  }
  if (opts.engine.kind === 'vllm') {
    // vLLM: run the OpenAI server via the provisioned venv python. modelPath is an
    // HF repo id or a local safetensors dir; llama.cpp LoadProfile flags don't apply,
    // but the multi-GPU shard count (ADR-054) maps to --tensor-parallel-size.
    return vllmServerCommand(opts.engine.binPath, opts.modelPath, port, '127.0.0.1', opts.tensorParallelSize)
  }
  return { cmd: opts.engine.binPath, args: buildArgs(opts, port, slotSavePath) }
}

/** Readiness deadline by engine kind. Python engines cold-start far slower than
 *  llama.cpp: vLLM loads weights, compiles CUDA graphs, and warms up — routinely
 *  minutes for a large model — so it gets a longer window before we declare a
 *  readiness timeout. */
function readinessTimeoutMs(kind: string): number {
  return kind === 'vllm' ? 600_000 : 120_000
}

/** Environment for Python-based engines (mlx, vllm). Returns undefined for native
 *  engines so they inherit the daemon env unchanged. For Python engines we:
 *   - force HuggingFace OFFLINE so a model load / request can never block on a network
 *     call (TurboLLM downloads models itself; it is offline-first), and
 *   - point the HF cache at a real, created dir inside the TurboLLM data dir so mlx-lm's
 *     `/v1/models` (which calls huggingface_hub `scan_cache_dir()`) doesn't crash with
 *     CacheNotFound when `~/.cache/huggingface/hub` is absent. */
function pyEngineEnv(kind: string, dataDir: string): NodeJS.ProcessEnv | undefined {
  if (kind !== 'mlx' && kind !== 'vllm') return undefined
  const hfHome = join(dataDir, 'hf-cache')
  const hubCache = join(hfHome, 'hub')
  mkdirSync(hubCache, { recursive: true })
  return {
    ...process.env,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_HOME: hfHome,
    HF_HUB_CACHE: hubCache,
  }
}

/** Scan a Python engine's log tail for a fatal model-load failure. mlx-lm loads the
 *  model in a background "_generate" thread; if `load_weights` throws (e.g. a model
 *  architecture or quantization the installed mlx-lm version doesn't support), that
 *  thread dies but the HTTP server keeps answering /v1/models, so chat requests queue
 *  to a dead thread and hang forever. We catch the crash and return a concise message;
 *  null when no such failure is present. */
function detectPyLoadFailure(lines: string[]): string | null {
  const text = lines.join('\n')
  // Gate on the load path specifically so unrelated tracebacks (e.g. the /v1/models
  // CacheNotFound handler) never false-trigger this.
  const isLoadCrash =
    /Exception in thread[^\n]*_generate/.test(text) ||
    /in load_default\b/.test(text) ||
    /in load_model\b/.test(text) ||
    /load_weights/.test(text)
  if (!isLoadCrash) return null
  // The final "SomeError: message" / "SomeException: message" line is the useful detail.
  const errLine = [...lines].reverse().find((l) => /^[A-Za-z_][\w.]*(Error|Exception):/.test(l.trim()))
  const detail = (errLine ? errLine.trim() : 'the model failed to load').slice(0, 200)
  return (
    `MLX could not load this model — ${detail} ` +
    `This usually means the installed mlx-lm version does not support this model's architecture or quantization.`
  )
}

function buildArgs(opts: StartOpts, port: number, slotSavePath?: string): string[] {
  const args = ['-m', opts.modelPath, '--host', '127.0.0.1', '--port', String(port)]
  const flags = opts.engine.capabilities.flags
  if (flags.length === 0 || flags.includes('--metrics')) args.push('--metrics')
  if (flags.includes('--no-webui')) args.push('--no-webui')
  // KV prompt-cache persistence (F-014): arms the slot save/restore endpoints. The caller
  // only supplies a path once it has checked the cap (caps.flags allow it) and made the dir.
  if (slotSavePath) args.push('--slot-save-path', slotSavePath)
  args.push(...opts.extraArgs)
  return args
}

function allocPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (p: number) => {
      if (p > 8181) return reject(new Error('no_free_port'))
      const srv = createServer()
      srv.once('error', () => tryPort(p + 1))
      srv.listen(p, '127.0.0.1', () => srv.close(() => resolve(p)))
    }
    tryPort(8081)
  })
}

// Readiness means the MODEL is loaded, not merely that the HTTP port is open. For
// llama-server, /health returns 503 while the model loads and 200 only once it is
// ready, so we trust it exclusively. /v1/models returns 200 the instant the socket
// binds (before the weights finish loading), so it is NOT a readiness signal:
// falling back to it made the engine flip to "running" prematurely and then to
// "error" when the load actually failed — the contradictory-status bug users hit.
// We use /v1/models only for engines that genuinely lack /health (e.g. mlx-lm,
// which 404/501s the route).
export async function probeReady(port: number): Promise<boolean> {
  const base = `http://127.0.0.1:${port}`
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })
    if (r.status === 200) return true
    // 404/501 → this engine has no /health route; fall through to /v1/models below.
    // 503 (still loading) or any other status → not ready yet, keep polling.
    if (r.status !== 404 && r.status !== 501) return false
  } catch {
    return false // connection refused / not up yet → keep polling
  }
  try {
    const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(1500) })
    return r.status === 200
  } catch {
    return false
  }
}

async function gracefulStop(child: ChildProcess, exited: Promise<void>): Promise<void> {
  signalTerm(child)
  const forced = sleep(8000).then(() => 'timeout' as const)
  const result = await Promise.race([exited.then(() => 'exited' as const), forced])
  if (result === 'timeout') {
    forceKill(child)
    await exited
  }
}

function signalTerm(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T'], () => {})
  } else {
    child.kill('SIGTERM')
  }
}

function forceKill(child: ChildProcess): void {
  if (!child.pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/F', '/T'], () => {})
  } else {
    child.kill('SIGKILL')
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
