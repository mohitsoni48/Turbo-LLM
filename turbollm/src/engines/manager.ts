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

    const { cmd, args } = engineCommand(opts, port)
    const child = spawn(cmd, args, { cwd: dirname(cmd), windowsHide: true })
    // end:false — otherwise whichever of stdout/stderr closes first would end the
    // shared log stream and drop the other's output. We close it in onTerminated.
    child.stdout?.pipe(logStream, { end: false })
    child.stderr?.pipe(logStream, { end: false })

    this.state = 'starting'
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
  logPath(): string {
    return this.logPathStr
  }
  generationStart(): void {
    this.generation++
  }
  generationEnd(): void {
    this.generation = Math.max(0, this.generation - 1)
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

async function probeReady(port: number): Promise<boolean> {
  const base = `http://127.0.0.1:${port}`
  try {
    const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })
    if (r.status === 200) return true
    if (r.status === 503) return false
  } catch {
    /* not up yet */
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
