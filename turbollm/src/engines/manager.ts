// Engine lifecycle state machine (A2, spec 03 §4): stopped → starting → running
// → stopping → stopped, plus error. Owns the single running engine process.
// Ports the verified Go manager to node:child_process.
import { ChildProcess, execFile, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import type { ConfigStore, Engine } from '../config/config'
import { mlxServerCommand } from './mlx'

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

    const { cmd, args } = engineCommand(opts, port)
    const child = spawn(cmd, args, { cwd: dirname(cmd), windowsHide: true })
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

  async stopAndWait(): Promise<void> {
    const exited = this.exited
    if (this.state === 'running' || this.state === 'starting') {
      this.stop()
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
    const deadline = Date.now() + 120_000
    for (;;) {
      await sleep(500)
      if (this.child !== child || this.state !== 'starting') return
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
            message: 'The model did not become ready within 120 seconds.',
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

/** Build the spawn command for an engine, branching on its kind (spec 03 §2b). */
function engineCommand(opts: StartOpts, port: number): { cmd: string; args: string[] } {
  if (opts.engine.kind === 'mlx') {
    // MLX: run the mlx-lm OpenAI server via the provisioned venv python. The
    // llama.cpp LoadProfile flags in opts.extraArgs do not apply and are dropped.
    return mlxServerCommand(opts.engine.binPath, opts.modelPath, port, '127.0.0.1')
  }
  return { cmd: opts.engine.binPath, args: buildArgs(opts, port) }
}

function buildArgs(opts: StartOpts, port: number): string[] {
  const args = ['-m', opts.modelPath, '--host', '127.0.0.1', '--port', String(port)]
  const flags = opts.engine.capabilities.flags
  if (flags.length === 0 || flags.includes('--metrics')) args.push('--metrics')
  if (flags.includes('--no-webui')) args.push('--no-webui')
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
