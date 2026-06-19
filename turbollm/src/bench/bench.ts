// Auto-benchmark + auto-tune runner (Differentiator #2, spec 09 §1). Owns the
// engine exclusively for the duration of a run: binary-searches candidate LoadProfiles,
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
import { deriveDefault, profileToArgs, resolveProfile, type LoadProfile } from '../models/profile'
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
// Per-candidate cap: model load + warmup + the measured request must all finish within this
// window, otherwise the candidate is recorded as 'timeout' and the sweep moves on — a single
// hung/too-slow config can never stall the whole run.
const PER_TEST_TIMEOUT_MS = 3 * 60_000
// Overall budget — sized to fit a full binary search of per-test-capped trials (~log2(layers)).
const TOTAL_BUDGET_MS = 20 * 60_000
const OOM_RE = /out of memory|cudaMalloc/i

// English text is roughly 4 characters per token — used to size the bench prompt.
const CHARS_PER_TOKEN = 4

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
  // Aborts the in-flight measurement request the instant cancel() is called, so a
  // stop/restart/load (kill switches) interrupts auto-tune immediately rather than
  // waiting out the current candidate's request.
  private abort: AbortController | null = null

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

  /** Cancel the active run: aborts the in-flight measurement immediately, stops after the
   *  current step, leaves the engine stopped, and keeps the partial results gathered so far
   *  (AC#3). A no-op when nothing is running. */
  cancel(): void {
    if (!this.state.running) return
    this.cancelled = true
    this.abort?.abort()
  }

  /** Resolve once no run is in flight (the runner has finished its teardown), or after
   *  `timeoutMs`. Lets a restart wait for auto-tune to release the engine before reloading,
   *  so the two don't race over the engine. */
  async waitIdle(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (this.state.running && Date.now() < deadline) await sleep(150)
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
    this.abort = new AbortController()
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

    const results: BenchCandidate[] = []
    let best: { cand: BenchCandidate; profile: LoadProfile } | null = null

    if (!entry.moe) {
      best = await this.denseSearch(entry, sys, baseProfile, caps, results)
    } else {
      best = await this.moeSearch(entry, sys, baseProfile, caps, results)
    }

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

  /** Binary search over ngl to find the highest number of GPU layers that does not OOM.
   *  For dense models, more GPU layers = faster (monotonically), so the optimal is simply
   *  the maximum ngl that fits in VRAM. O(log blockCount) trials — far more precise than
   *  the old fixed-set sweep. CPU-only machines skip straight to ngl=0. */
  private async denseSearch(
    entry: ModelEntry,
    sys: SysInfo,
    base: LoadProfile,
    caps: Engine['capabilities'],
    results: BenchCandidate[],
  ): Promise<{ cand: BenchCandidate; profile: LoadProfile } | null> {
    const hasGpu = sys.gpus.length > 0

    if (!hasGpu) {
      const label = 'ngl=0 (CPU-only)'
      const cand = await this.measure(entry, sys, { ...base, ngl: 0 }, caps, label, label)
      results.push(cand)
      this.state = { ...this.state, candidates: results }
      if (cand.outcome === 'ok') return { cand, profile: { ...base, ngl: 0 } }
      return null
    }

    // Binary search: find highest ngl ∈ [0, blockCount] with outcome 'ok'.
    // OOM or crash → search lower; ok → record and search higher.
    const hi0 = entry.blockCount > 0 ? entry.blockCount : 99
    let lo = 0, hi = hi0
    let best: { cand: BenchCandidate; profile: LoadProfile } | null = null

    while (lo <= hi && !this.cancelled && Date.now() <= this.deadline) {
      const mid = Math.floor((lo + hi) / 2)
      const label = `ngl=${mid}`
      const stepPrefix = `Trial ${results.length + 1}: ${label} (range ${lo}–${hi})`
      this.state = { ...this.state, step: `${stepPrefix}…`, candidates: results }
      const profile: LoadProfile = { ...base, ngl: mid }
      const cand = await this.measure(entry, sys, profile, caps, label, stepPrefix)
      results.push(cand)
      this.state = { ...this.state, candidates: results }

      if (cand.outcome === 'ok' && cand.tps !== null) {
        // More GPU layers is always faster; the last ok in the search has the highest ngl.
        if (!best || cand.tps > (best.cand.tps ?? 0)) best = { cand, profile }
        this.state = { ...this.state, bestTps: best.cand.tps ?? undefined }
        lo = mid + 1  // try higher
      } else if (cand.outcome === 'oom') {
        hi = mid - 1  // too many layers, try fewer
      } else {
        // crash / timeout — treat conservatively
        hi = mid - 1
      }
    }
    return best
  }

  /** Binary search over nCpuMoe to find the minimum number of MoE experts kept on CPU
   *  that still fits in VRAM. Fewer CPU experts = more on GPU = faster; we want the
   *  minimum that doesn't OOM. O(log blockCount) trials. */
  private async moeSearch(
    entry: ModelEntry,
    sys: SysInfo,
    base: LoadProfile,
    caps: Engine['capabilities'],
    results: BenchCandidate[],
  ): Promise<{ cand: BenchCandidate; profile: LoadProfile } | null> {
    const derived = deriveDefault(entry, sys)
    const maxN = entry.blockCount > 0 ? entry.blockCount : (derived.nCpuMoe || 0)
    let lo = 0, hi = maxN
    let best: { cand: BenchCandidate; profile: LoadProfile } | null = null

    while (lo <= hi && !this.cancelled && Date.now() <= this.deadline) {
      const mid = Math.floor((lo + hi) / 2)
      const label = `nCpuMoe=${mid}`
      const stepPrefix = `Trial ${results.length + 1}: ${label} (range ${lo}–${hi})`
      this.state = { ...this.state, step: `${stepPrefix}…`, candidates: results }
      const profile: LoadProfile = { ...base, nCpuMoe: mid }
      const cand = await this.measure(entry, sys, profile, caps, label, stepPrefix)
      results.push(cand)
      this.state = { ...this.state, candidates: results }

      if (cand.outcome === 'oom' || overVram(cand.vramMb, sys)) {
        lo = mid + 1  // need more CPU experts to free VRAM
      } else if (cand.outcome === 'ok' && cand.tps !== null) {
        // Fewer CPU experts = more GPU = faster; record and try even fewer.
        if (!best || cand.tps > (best.cand.tps ?? 0)) best = { cand, profile }
        this.state = { ...this.state, bestTps: best.cand.tps ?? undefined }
        hi = mid - 1
      } else {
        lo = mid + 1  // crash / timeout → treat as memory pressure
      }
    }
    return best
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
    stepPrefix: string,
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
    // Live sub-phase progress so each (possibly multi-minute) trial isn't a silent wait.
    const phase = (p: string) => { this.state = { ...this.state, step: `${stepPrefix} — ${p}` } }

    const active = this.registry.active()
    if (!active) return fail('crash')

    // Per-test cap (3 min): the whole trial — load + warmup + measured request — must finish
    // within this, else it's recorded 'timeout' and the sweep continues. Also bounded by the
    // global deadline so a near-budget start can't overrun.
    const testDeadline = Math.min(Date.now() + PER_TEST_TIMEOUT_MS, this.deadline)
    const remaining = () => Math.max(1_000, testDeadline - Date.now())

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
    phase('loading model…')
    try {
      await this.manager.start(opts)
    } catch {
      return fail('crash')
    }

    // Wait for ready / detect crash / OOM within the readiness window (and per-test cap).
    const outcome = await this.awaitReady(testDeadline)
    if (outcome !== 'ok') {
      await this.manager.stopAndWait().catch(() => {})
      return fail(outcome)
    }

    const target = this.manager.target()
    if (!target) {
      await this.manager.stopAndWait().catch(() => {})
      return fail('crash')
    }

    // Bench prompt = 75% of the configured ctx — a realistic fraction of the window the user
    // will actually use, leaving room for generation (see benchPromptTokens).
    const promptContent = makeBenchContent(benchPromptTokens(profile.ctx))

    // Warmup (discarded) then the measured request — both bounded by the remaining per-test time.
    phase('warming up…')
    await this.chat(target, promptContent, 16, remaining()).catch(() => null)
    phase('measuring t/s…')
    const timed = await this.chat(target, promptContent, 128, remaining()).catch(() => null)
    const vramAfter = await readNvidiaVramMb()
    await this.manager.stopAndWait().catch(() => {})

    // A null result past the per-test deadline is a timeout (too slow), not a crash.
    if (!timed) return fail(Date.now() >= testDeadline ? 'timeout' : 'crash')
    const vramMb = vramBefore !== null && vramAfter !== null ? Math.max(0, vramAfter - vramBefore) : vramAfter
    return { label, params, outcome: 'ok', tps: timed.tps, ttftMs: timed.ttftMs, vramMb }
  }

  /** Poll the manager state until the engine is running, the readiness window
   *  elapses (timeout), the process exits (crash), or an OOM line appears in the
   *  log (oom). Honors cancel + the global deadline. */
  private async awaitReady(testDeadline: number): Promise<'ok' | 'timeout' | 'crash' | 'oom'> {
    // Bounded by both the readiness window and the per-test cap (whichever is sooner).
    const deadline = Math.min(Date.now() + READY_TIMEOUT_MS, testDeadline)
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

  /** One non-streaming /v1/chat/completions request with the given content string.
   *  Returns engine-reported tps (predicted_per_second) + ttftMs (prompt_ms).
   *  `timeoutMs` is the remaining per-test budget — the request aborts when it elapses. */
  private async chat(target: string, content: string, maxTokens: number, timeoutMs: number): Promise<{ tps: number; ttftMs: number } | null> {
    const res = await fetch(`${target}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'bench',
        messages: [{ role: 'user', content }],
        max_tokens: maxTokens,
        temperature: 0,
        seed: 42,
        stream: false,
      }),
      // Abort on the per-test timeout OR when cancel() fires (stop/restart/load kill switch).
      signal: this.abort
        ? AbortSignal.any([AbortSignal.timeout(timeoutMs), this.abort.signal])
        : AbortSignal.timeout(timeoutMs),
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

/** Filler text for the bench prompt — varied enough to avoid tokenizer-dedup tricks. */
const BENCH_BASE =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud ' +
  'exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure ' +
  'dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ' +
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt ' +
  'mollit anim id est laborum. '

/** Build a bench prompt of approximately `targetTokens` tokens by repeating BENCH_BASE.
 *  Uses a 4-chars-per-token estimate — close enough for English lorem text. */
function makeBenchContent(targetTokens: number): string {
  const targetChars = Math.max(BENCH_BASE.length, targetTokens * CHARS_PER_TOKEN)
  const reps = Math.ceil(targetChars / BENCH_BASE.length)
  return BENCH_BASE.repeat(reps).slice(0, targetChars) + '\n\nSummarize the passage above in one sentence.'
}

/** How many prompt tokens to use for a bench trial at a given ctx size: 75% of the configured
 *  context. A realistic fraction of the window the user will actually use, leaving the remaining
 *  25% for generation. (KV/VRAM is allocated for the full ctx at load regardless of prompt size,
 *  so this only sizes the prefill-speed measurement — not the VRAM-fit decision.) */
function benchPromptTokens(ctx: number): number {
  return Math.max(256, Math.floor(ctx * 0.75))
}

/** True when a measured VRAM figure exceeds 95% of the primary GPU's VRAM. */
function overVram(vramMb: number | null, sys: SysInfo): boolean {
  const total = sys.gpus[0]?.vramMb ?? 0
  if (!vramMb || total <= 0) return false
  return vramMb > total * 0.95
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
