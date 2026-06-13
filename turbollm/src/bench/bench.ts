// Auto-benchmark + auto-tune runner (Differentiator #2, spec 09 §1). Owns the
// engine exclusively for the duration of a run: sweeps candidate LoadProfiles,
// measures real tok/s on the user's hardware, saves the best as the model's
// profile (tunedBy:'bench'), persists a benchResults row, and — when telemetry is
// on — queues an anonymized bench_result event. Single active run; additive;
// fail-safe (a bad candidate is recorded and the sweep continues).
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BenchResult, ConfigStore } from '../config/config'
import type { Manager, StartOpts } from '../engines/manager'
import type { Registry } from '../engines/registry'
import type { Engine } from '../config/config'
import type { Scanner, ModelEntry } from '../models/scanner'
import { deriveDefault, estimateVram, profileToArgs, resolveProfile, type LoadProfile } from '../models/profile'
import { getSysInfo, type SysInfo } from '../sysinfo/sysinfo'

/** A single candidate the sweep evaluated. `outcome` is 'ok' on a measured run, or
 *  the failure mode (timeout/crash/oom) — the sweep keeps going on a failure. */
export interface BenchCandidate {
  label: string
  params: { ctx: number; ngl: number; nCpuMoe: number; parallel: number; kvTypeK: string; flashAttn: string }
  outcome: 'ok' | 'timeout' | 'crash' | 'oom'
  tps: number | null
  ttftMs: number | null
  vramMb: number | null
}

/** Live state surfaced on GET /status (spec 02 §7 / 09 §1). `running:false` resets
 *  step/best; `done`/`error` linger after a finished run until the next starts. */
export interface BenchState {
  running: boolean
  modelKey?: string
  step?: string
  bestTps?: number
  candidates?: BenchCandidate[]
  done?: boolean
  error?: string
}

// Hard limits (spec 09 §1).
const READY_TIMEOUT_MS = 120_000
const TOTAL_BUDGET_MS = 10 * 60_000
const OOM_RE = /out of memory|cudaMalloc/i
const MAX_DENSE = 3
const MAX_MOE = 8

export class BenchError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'BenchError'
  }
}

export class BenchRunner {
  private state: BenchState = { running: false }
  private cancelled = false
  private deadline = 0

  constructor(
    private manager: Manager,
    private store: ConfigStore,
    private scanner: Scanner,
    private registry: Registry,
    private version: string,
  ) {}

  /** Live state for GET /status. */
  status(): BenchState {
    return this.state
  }

  /** Whether a run is in flight (drives the 409 on a second start). */
  isRunning(): boolean {
    return this.state.running
  }

  /** Cancel the active run: it stops after the current step, leaves the engine
   *  stopped, and keeps the partial results gathered so far (AC#3). */
  cancel(): void {
    if (this.state.running) this.cancelled = true
  }

  /** Start a run for `modelKey`. Rejects (throws BenchError) when a run is already
   *  active, the engine is busy, or the model isn't a benchmarkable GGUF. The run
   *  itself proceeds in the background; callers get 202 + poll /status. */
  start(modelKey: string, base?: Partial<LoadProfile>): void {
    if (this.state.running) throw new BenchError('bench_running', 'A benchmark is already running.')
    const engineState = this.manager.status().state
    if (engineState === 'running' || engineState === 'starting' || engineState === 'stopping') {
      throw new BenchError('engine_in_use', 'Stop the running model before benchmarking.')
    }
    const active = this.registry.active()
    if (!active) throw new BenchError('no_active_engine', 'Register and select an engine first.')
    if (active.kind === 'mlx') throw new BenchError('unsupported_model', 'Auto-tune supports llama.cpp (GGUF) models only.')
    const entry = this.scanner.get(modelKey)
    if (!entry) throw new BenchError('no_such_model', 'No model with that key.')
    if (entry.format !== 'gguf') throw new BenchError('unsupported_model', 'Auto-tune supports GGUF models only.')
    if (entry.incomplete || entry.parseError) throw new BenchError('model_not_loadable', 'This model is incomplete or unreadable.')

    this.cancelled = false
    this.deadline = Date.now() + TOTAL_BUDGET_MS
    this.state = { running: true, modelKey, step: 'Preparing…', candidates: [] }
    void this.run(modelKey, entry, base).catch((e) => {
      // The run is fully guarded internally; this is a last-resort net so a thrown
      // error never leaves `running` stuck true.
      this.state = { running: false, modelKey, done: true, error: e instanceof Error ? e.message : String(e), candidates: this.state.candidates }
      void this.manager.stopAndWait().catch(() => {})
    })
  }

  // ---- the run ------------------------------------------------------------

  private async run(modelKey: string, entry: ModelEntry, base?: Partial<LoadProfile>): Promise<void> {
    const sys = getSysInfo()
    const active = this.registry.active()
    const caps = active?.capabilities ?? { flags: [], kvTypes: [] }
    const saved = this.store.snapshot().modelProfiles[modelKey] as Partial<LoadProfile> | undefined
    const defaults = this.store.snapshot().modelDefaults
    // Honor the user's CURRENT config (the dialog draft, passed as `base`) as the fixed
    // basis for every candidate — ctx, KV quant, flash-attn, etc. Auto-tune only sweeps
    // offload (ngl / nCpuMoe) on top, so the result reflects the settings they'll load
    // with. `base` overrides the saved profile + global defaults.
    const baseProfile = resolveProfile(entry, sys, saved, base, defaults)

    const candidates = this.buildCandidates(entry, sys, baseProfile)
    const results: BenchCandidate[] = []
    let best: { cand: BenchCandidate; profile: LoadProfile } | null = null

    for (const { profile, label } of candidates) {
      if (this.cancelled || Date.now() > this.deadline) break
      this.state = { ...this.state, step: `${label}…`, candidates: results }
      const cand = await this.measure(entry, sys, profile, caps, label)
      results.push(cand)
      this.state = { ...this.state, candidates: results }
      if (cand.outcome === 'ok' && cand.tps !== null) {
        if (!best || cand.tps > (best.cand.tps ?? 0)) {
          best = { cand, profile }
          this.state = { ...this.state, bestTps: cand.tps, step: `${label} → ${cand.tps.toFixed(1)} tok/s` }
        }
      }
      // MoE sweep early-stop: first OOM (or VRAM>95%) means deeper offload is needed —
      // descending further (less CPU offload) only gets worse. Stop sweeping down.
      if (entry.moe && (cand.outcome === 'oom' || overVram(cand.vramMb, sys))) break
    }

    // (KV cache type is NOT swept — auto-tune respects the user's chosen KV quant
    // from their config, same as ctx. It tunes offload only.)

    // Engine is always left stopped at the end of a run (AC#3 for cancel; also tidy
    // for a normal finish — the user explicitly loads afterward).
    await this.manager.stopAndWait().catch(() => {})

    if (best) {
      const record = this.persistBest(modelKey, best.profile, best.cand)
      this.queueTelemetry(record, entry, sys, this.version, active?.version ?? '')
      this.state = { running: false, modelKey, done: true, bestTps: best.cand.tps ?? undefined, candidates: results }
    } else {
      // No candidate measured successfully — keep the partial results, surface a
      // soft error (every candidate's outcome is visible in `candidates`).
      const err = this.cancelled ? undefined : 'No candidate completed successfully.'
      this.state = { running: false, modelKey, done: true, error: err, candidates: results }
    }
  }

  /** Build the candidate sweep (spec 09 §1). Dense ≤3, MoE ≤8. Each carries the
   *  REAL-ctx profile; the measurement clamps ctx itself. */
  private buildCandidates(
    entry: ModelEntry,
    sys: SysInfo,
    base: LoadProfile,
  ): Array<{ profile: LoadProfile; label: string }> {
    const out: Array<{ profile: LoadProfile; label: string }> = []
    const hasGpu = sys.gpus.length > 0

    if (!entry.moe) {
      // Dense: all-on-GPU first; if that overflows VRAM, add a best-fit ngl.
      const all: LoadProfile = { ...base, ngl: hasGpu ? 99 : 0 }
      out.push({ profile: all, label: `ngl=${all.ngl}` })
      if (hasGpu && entry.blockCount > 0) {
        const fit = bestFitNgl(all, entry, sys)
        if (fit < 99 && fit > 0) out.push({ profile: { ...base, ngl: fit }, label: `ngl=${fit}` })
      }
      return out.slice(0, MAX_DENSE)
    }

    // MoE: nCpuMoe descending from the derived default in steps of 2 toward 0.
    const derived = deriveDefault(entry, sys)
    const startN = Math.max(0, Math.min(entry.blockCount || derived.nCpuMoe, derived.nCpuMoe))
    const seen = new Set<number>()
    for (let n = startN; n >= 0 && out.length < MAX_MOE - 1; n -= 2) {
      if (seen.has(n)) continue
      seen.add(n)
      out.push({ profile: { ...base, nCpuMoe: n }, label: `nCpuMoe=${n}` })
    }
    return out.slice(0, MAX_MOE)
  }

  /** The measurement primitive (spec 09 §1): launch the candidate, detect
   *  ready/timeout/crash/oom, then warm up + one measured request. Never throws —
   *  any failure maps to an outcome so the sweep can continue (AC#2). */
  private async measure(
    entry: ModelEntry,
    sys: SysInfo,
    profile: LoadProfile,
    caps: Engine['capabilities'],
    label: string,
  ): Promise<BenchCandidate> {
    const params = {
      ctx: profile.ctx,
      ngl: profile.ngl,
      nCpuMoe: profile.nCpuMoe,
      parallel: profile.parallel,
      kvTypeK: profile.kvTypeK,
      flashAttn: profile.flashAttn,
    }
    const fail = (outcome: BenchCandidate['outcome']): BenchCandidate => ({ label, params, outcome, tps: null, ttftMs: null, vramMb: null })

    const active = this.registry.active()
    if (!active) return fail('crash')

    // Run at the user's REAL ctx (no clamp): VRAM use + OOM behavior then reflect the
    // actual config they'll load with, so the winning offload is one that genuinely
    // fits. The measured request itself is small and tok/s is ~ctx-independent.
    const opts: StartOpts = {
      engine: active,
      model: { key: entry.key, name: entry.name, quant: entry.quant, ctx: profile.ctx, vision: entry.vision },
      modelPath: entry.path,
      extraArgs: profileToArgs(profile, entry, caps, sys.cores),
    }

    const vramBefore = await readNvidiaVramMb()
    try {
      await this.manager.start(opts)
    } catch {
      return fail('crash')
    }

    // Wait for ready / detect crash / OOM within the readiness window.
    const outcome = await this.awaitReady()
    if (outcome !== 'ok') {
      await this.manager.stopAndWait().catch(() => {})
      return fail(outcome)
    }

    const target = this.manager.target()
    if (!target) {
      await this.manager.stopAndWait().catch(() => {})
      return fail('crash')
    }

    // Warmup (discarded) then the measured request.
    await this.chat(target, 16).catch(() => null)
    const timed = await this.chat(target, 128).catch(() => null)
    const vramAfter = await readNvidiaVramMb()
    await this.manager.stopAndWait().catch(() => {})

    if (!timed) return fail('crash')
    const vramMb = vramBefore !== null && vramAfter !== null ? Math.max(0, vramAfter - vramBefore) : vramAfter
    return { label, params, outcome: 'ok', tps: timed.tps, ttftMs: timed.ttftMs, vramMb }
  }

  /** Poll the manager state until the engine is running, the readiness window
   *  elapses (timeout), the process exits (crash), or an OOM line appears in the
   *  log (oom). Honors cancel + the global deadline. */
  private async awaitReady(): Promise<'ok' | 'timeout' | 'crash' | 'oom'> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    for (;;) {
      await sleep(400)
      if (this.cancelled) return 'crash' // treated as a non-ok outcome; engine stopped by caller
      const st = this.manager.status()
      if (st.state === 'running') return 'ok'
      if (st.state === 'error' || st.state === 'stopped') {
        // Distinguish OOM from a generic crash via the captured log tail.
        const tail = st.err?.logTail ?? []
        if (tail.some((l) => OOM_RE.test(l))) return 'oom'
        return 'crash'
      }
      if (Date.now() > deadline || Date.now() > this.deadline) return 'timeout'
    }
  }

  /** One non-streaming /v1/chat/completions request with the fixed deterministic
   *  prompt. Returns engine-reported tps (predicted_per_second) + ttftMs (prompt_ms). */
  private async chat(target: string, maxTokens: number): Promise<{ tps: number; ttftMs: number } | null> {
    const res = await fetch(`${target}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'bench',
        messages: [{ role: 'user', content: BENCH_PROMPT }],
        max_tokens: maxTokens,
        temperature: 0,
        seed: 42,
        stream: false,
      }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { timings?: { predicted_per_second?: number; prompt_ms?: number } }
    const t = data.timings
    if (!t || typeof t.predicted_per_second !== 'number') return null
    return { tps: t.predicted_per_second, ttftMs: typeof t.prompt_ms === 'number' ? t.prompt_ms : 0 }
  }

  /** Save the winning profile as the model's saved profile (tunedBy:'bench') and
   *  persist a benchResults row. Both via the same ConfigStore the route uses. */
  private persistBest(modelKey: string, profile: LoadProfile, cand: BenchCandidate): BenchResult {
    const record: BenchResult = {
      modelKey,
      tps: cand.tps ?? 0,
      ttftMs: cand.ttftMs ?? 0,
      vramMb: cand.vramMb,
      params: cand.params,
      ts: new Date().toISOString(),
    }
    const tuned: LoadProfile = { ...profile, tunedBy: 'bench' }
    this.store.update((cfg) => {
      cfg.modelProfiles[modelKey] = tuned as unknown as Record<string, unknown>
      cfg.benchResults[modelKey] = record
    })
    return record
  }

  /** Queue an anonymized bench_result telemetry event (spec 09 §3) — ONLY when
   *  telemetry is on. Built from whitelisted fields only (never prompts, paths,
   *  tokens). No uploader (post-launch); just a queue file. Fully fail-safe. */
  private queueTelemetry(record: BenchResult, entry: ModelEntry, sys: SysInfo, appVersion: string, engineVersion: string): void {
    try {
      const cfg = this.store.snapshot()
      const level = cfg.telemetry.level
      if (level !== 'anon' && level !== 'full') return // 'off' / 'unset' → write nothing (AC#4)

      // Lazily mint a stable per-install machineId (never generated while off).
      let machineId = cfg.telemetry.machineId
      if (!machineId) {
        machineId = randomUUID()
        this.store.update((c) => {
          if (!c.telemetry.machineId) c.telemetry.machineId = machineId
        })
      }

      const event = {
        schema: 1,
        event: 'bench_result',
        ts: record.ts,
        machineId,
        app: { version: appVersion, os: sys.os },
        hw: {
          cpu: sys.cpu,
          ramMb: sys.ramMB,
          gpus: sys.gpus.map((g) => ({ name: g.name, vramMb: g.vramMb })),
        },
        payload: {
          model: { name: entry.name, quant: entry.quant, sizeBytes: entry.sizeBytes, arch: entry.arch, moe: entry.moe },
          engine: { version: engineVersion },
          params: record.params,
          result: { tps: record.tps, ttftMs: record.ttftMs, vramMb: record.vramMb, outcome: 'ok' },
        },
      }

      const queueDir = join(this.store.dir(), 'telemetry', 'queue')
      mkdirSync(queueDir, { recursive: true })
      writeFileSync(join(queueDir, `${randomUUID()}.json`), JSON.stringify(event))
    } catch {
      // Telemetry is best-effort and offline-first: a failure to queue must never
      // surface to the user or abort the run (spec 09 §4).
    }
  }
}

// ---- helpers ----------------------------------------------------------------

/** ~512 tokens of deterministic lorem-style text for the measured request. */
const BENCH_PROMPT = ('Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud ' +
  'exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure ' +
  'dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ' +
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt ' +
  'mollit anim id est laborum. ').repeat(6) + 'Summarize the passage above in one sentence.'

/** True when a measured VRAM figure exceeds 95% of the primary GPU's VRAM. */
function overVram(vramMb: number | null, sys: SysInfo): boolean {
  const total = sys.gpus[0]?.vramMb ?? 0
  if (!vramMb || total <= 0) return false
  return vramMb > total * 0.95
}

/** The smallest ngl whose estimate fits ~85% of VRAM, for the dense overflow case.
 *  Returns 99 when even full offload fits (no second candidate needed). Local copy
 *  of the fit search so bench doesn't depend on profile internals beyond the public
 *  estimateVram. */
function bestFitNgl(p: LoadProfile, entry: ModelEntry, sys: SysInfo): number {
  const total = sys.gpus[0]?.vramMb ?? 0
  if (total <= 0 || entry.blockCount <= 0) return 99
  const budget = total * 0.85
  // Walk down from full offload to find the largest ngl whose estimate fits.
  for (let n = Math.min(99, entry.blockCount); n >= 0; n--) {
    if (estimateVram({ ...p, ngl: n }, entry, sys).estMb <= budget) return n
  }
  return 0
}

/** Best-effort current NVIDIA VRAM use in MB (sum across GPUs). Null on non-NVIDIA
 *  or when nvidia-smi is absent — never throws (spec 09 §1). */
function readNvidiaVramMb(): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      execFile(
        'nvidia-smi',
        ['--query-gpu=memory.used', '--format=csv,noheader,nounits'],
        { timeout: 8000, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) return resolve(null)
          const total = stdout
            .trim()
            .split('\n')
            .map((l) => parseInt(l.trim(), 10))
            .filter((n) => Number.isFinite(n))
            .reduce((a, b) => a + b, 0)
          resolve(total > 0 ? total : null)
        },
      )
    } catch {
      resolve(null)
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
