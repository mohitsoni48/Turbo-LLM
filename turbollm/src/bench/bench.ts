// Auto-benchmark + auto-tune runner (Differentiator #2, spec 09 §1). Owns the
// engine exclusively for the duration of a run: binary-searches candidate LoadProfiles,
// measures real tok/s on the user's hardware, saves the best as the model's
// profile (tunedBy:'bench'), persists a benchResults row, and — when telemetry is
// on — queues an anonymized bench_result event. Single active run; additive;
// fail-safe (a bad candidate is recorded and the sweep continues).
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  /** The winning candidate, surfaced when a run finishes so the UI can show a Save/Cancel
   *  results dialog. The profile is NOT persisted until the user clicks Save (POST /bench/save). */
  result?: { params: BenchCandidate['params']; tps: number; ttftMs: number; vramMb: number | null }
}

// Hard limits (spec 09 §1).
// Readiness window: how long to wait for a candidate to come up before calling it a timeout.
// Generous enough for a large model (e.g. a 35B) to load; a candidate that over-allocates VRAM
// is caught faster than this by scanning the live log for an OOM signature (see awaitReady).
const READY_TIMEOUT_MS = 150_000
// Per-candidate cap: load + warmup + the measured request must all finish within this window,
// else the candidate is recorded 'timeout' and the sweep moves on — one hung config can't stall
// the run.
const PER_TEST_TIMEOUT_MS = 3 * 60_000
// Grace before judging prefill speed — give the first tokens time to flow before projecting.
const PREFILL_GRACE_MS = 8_000
// Overall budget — sized to fit a full binary search of per-test-capped trials (~log2(layers)).
const TOTAL_BUDGET_MS = 20 * 60_000
// Memory-pressure / GPU-exhaustion signatures. Beyond a clean "out of memory", a config that
// overflows VRAM often surfaces a secondary CUDA fault (failed allocation, or "device not ready"
// during graph capture once the allocation failed). Treat all of these as OOM so the search
// offloads more and the result reads as a fit problem rather than a mystery crash.
const OOM_RE = /out of memory|cudaMalloc|failed to allocate|unable to allocate|device not ready|CUDA error/i

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
  // The finished run's winning candidate, held (not persisted) until the user clicks Save.
  private winning:
    | { modelKey: string; profile: LoadProfile; cand: BenchCandidate; entry: ModelEntry; sys: SysInfo; engineVersion: string }
    | null = null

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
    this.winning = null // discard any unsaved result too
    this.state = { ...this.state, result: undefined } // don't re-show the results dialog
    if (!this.state.running) return
    this.cancelled = true
    this.abort?.abort()
  }

  /** Persist the finished run's winning profile (the user clicked Save). Returns false if there is
   *  nothing to save (no completed run, or it was already saved / discarded). */
  saveResult(): boolean {
    const w = this.winning
    if (!w) return false
    const record = this.persistBest(w.modelKey, w.profile, w.cand)
    this.queueTelemetry(record, w.entry, w.sys, this.version, w.engineVersion)
    this.winning = null
    this.state = { ...this.state, result: undefined } // consumed — don't re-show the dialog
    return true
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
    this.winning = null
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
      // Hold the winner instead of auto-saving — the UI shows a Save/Cancel results dialog and
      // persists via POST /bench/save only when the user clicks Save.
      this.winning = { modelKey, profile: best.profile, cand: best.cand, entry, sys, engineVersion: active?.version ?? '' }
      this.state = {
        running: false,
        modelKey,
        done: true,
        bestTps: best.cand.tps ?? undefined,
        result: { params: best.cand.params, tps: best.cand.tps ?? 0, ttftMs: best.cand.ttftMs ?? 0, vramMb: best.cand.vramMb },
        candidates: results,
      }
    } else {
      // No candidate measured successfully — keep the partial results, surface a soft error
      // (every candidate's outcome is visible in `candidates`). When every trial ran out of VRAM,
      // say so with the context size so the fix (lower ctx) is obvious — rather than a vague crash.
      const memoryBound = results.length > 0 && results.every((r) => r.outcome === 'oom')
      const err = this.cancelled
        ? undefined
        : memoryBound
          ? `This model doesn't fit on your GPU at ${baseProfile.ctx.toLocaleString()} context — even with maximum CPU offload it ran out of VRAM. Lower the context length and try again.`
          : 'No candidate completed successfully.'
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
      await this.settleGpu()

      if (cand.outcome === 'ok' && cand.tps !== null) {
        // More GPU layers is faster UP TO the no-spill edge; record and try higher. confirmPeak()
        // afterward walks back down if the highest "ok" was actually spilling over PCIe.
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
    return best ? await this.confirmPeak(entry, sys, base, caps, results, best, 'ngl', 0) : null
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
      await this.settleGpu()

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
    return best ? await this.confirmPeak(entry, sys, base, caps, results, best, 'nCpuMoe', maxN) : null
  }

  /** Spill correction (unimodal throughput). The binary search picks the config that "fits", but a
   *  config that overflows VRAM into shared memory passes the fit/prefill check yet is PCIe-bottlenecked
   *  — so t/s actually PEAKS at the no-spill edge and drops once spilling. After the search, step ONE
   *  toward LESS GPU (moe: +1 expert on CPU; dense: -1 GPU layer) and keep it only while it's faster:
   *  if the pick was spilling, this follows the curve up to the real peak; if not, it confirms the pick
   *  in one extra trial. */
  private async confirmPeak(
    entry: ModelEntry,
    sys: SysInfo,
    base: LoadProfile,
    caps: Engine['capabilities'],
    results: BenchCandidate[],
    best: { cand: BenchCandidate; profile: LoadProfile },
    knob: 'ngl' | 'nCpuMoe',
    maxNCpuMoe: number,
  ): Promise<{ cand: BenchCandidate; profile: LoadProfile }> {
    for (let guard = 0; guard < 8 && !this.cancelled && Date.now() <= this.deadline; guard++) {
      const cur = knob === 'nCpuMoe' ? best.cand.params.nCpuMoe : best.cand.params.ngl
      const next = knob === 'nCpuMoe' ? cur + 1 : cur - 1 // one step toward LESS GPU
      if (knob === 'nCpuMoe' ? next > maxNCpuMoe : next < 0) break
      const label = `${knob}=${next}`
      this.state = { ...this.state, step: `Confirming ${label} (spill check)…`, candidates: results }
      const profile: LoadProfile = knob === 'nCpuMoe' ? { ...base, nCpuMoe: next } : { ...base, ngl: next }
      const cand = await this.measure(entry, sys, profile, caps, label, `Confirming ${label}`)
      results.push(cand)
      this.state = { ...this.state, candidates: results }
      await this.settleGpu()
      if (cand.outcome === 'ok' && cand.tps !== null && cand.tps > (best.cand.tps ?? 0)) {
        best = { cand, profile } // the previous pick was spilling — this one's faster
        this.state = { ...this.state, bestTps: best.cand.tps ?? undefined }
      } else {
        break // no improvement → the previous pick is the peak
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
    const logPath = this.manager.logPath()

    // Bench prompt = 75% of the configured ctx, capped at 50k (see benchPromptTokens).
    const promptContent = makeBenchContent(benchPromptTokens(profile.ctx))

    // Prefill gate (doubles as warmup): stream the prompt and fail fast if it's spilling/crawling
    // or the engine faults — so a config that doesn't fit at this ctx is rejected in seconds and the
    // search offloads more, instead of hanging out the whole per-test budget.
    phase('warming up…')
    const warm = await this.prefillProbe(target, promptContent, remaining(), logPath, stepPrefix)
    if (warm !== 'ok') {
      await this.manager.stopAndWait().catch(() => {})
      return fail(warm.fault)
    }
    phase('measuring t/s…')
    const measured = await this.runChatWatched(target, promptContent, 128, remaining(), logPath)
    const vramAfter = await readNvidiaVramMb()
    await this.manager.stopAndWait().catch(() => {})

    if ('fault' in measured) return fail(measured.fault)
    const vramMb = vramBefore !== null && vramAfter !== null ? Math.max(0, vramAfter - vramBefore) : vramAfter
    return { label, params, outcome: 'ok', tps: measured.tps, ttftMs: measured.ttftMs, vramMb }
  }

  /** Poll the manager state until the engine is running, the readiness window
   *  elapses (timeout), the process exits (crash), or an OOM line appears in the
   *  log (oom). Honors cancel + the global deadline. */
  private async awaitReady(testDeadline: number): Promise<'ok' | 'timeout' | 'crash' | 'oom'> {
    const deadline = Math.min(Date.now() + READY_TIMEOUT_MS, testDeadline, this.deadline)
    const logPath = this.manager.logPath()
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
      // Still 'starting' — but a candidate that over-allocates VRAM can hang here without the
      // process cleanly exiting (it allocates/thrashes instead of crashing). Scan the LIVE engine
      // log so we catch the OOM / "device not ready" right away rather than waiting out the window.
      if (logPath && OOM_RE.test(readLiveTail(logPath))) return 'oom'
      if (Date.now() > deadline) return 'timeout'
    }
  }

  /** After a candidate's engine is stopped, wait for the GPU to actually release its VRAM (and the
   *  driver to settle) before the next candidate loads. A trial that exhausts VRAM can leave the GPU
   *  in a "device not ready" state that otherwise cascades into every following trial failing — the
   *  cause of spurious "no candidate found" on large models. Returns fast when VRAM is already low
   *  (the normal success case). Best-effort; never throws. */
  private async settleGpu(): Promise<void> {
    await sleep(1500) // base: let the killed engine process release + the driver settle
    let prev = await readNvidiaVramMb()
    if (prev === null) return // non-NVIDIA / no nvidia-smi: the fixed wait is all we can do
    for (let i = 0; i < 12 && !this.cancelled; i++) {
      await sleep(1000)
      const cur = await readNvidiaVramMb()
      if (cur === null || cur >= prev - 64) return // released / stabilized (no further drop)
      prev = cur
    }
  }

  /** A measured chat that aborts the instant the engine faults, so a config that doesn't fit fails
   *  in seconds instead of hanging out the per-test budget. A watchdog polls the engine state + the
   *  live engine log; on an OOM / "device not ready" / process death it aborts the request and the
   *  result is classified accordingly. Returns the timing, or a `fault` outcome. */
  private async runChatWatched(
    target: string,
    content: string,
    maxTokens: number,
    budgetMs: number,
    logPath: string,
  ): Promise<{ tps: number; ttftMs: number } | { fault: 'oom' | 'crash' | 'timeout' }> {
    const probe = new AbortController()
    let fault: 'oom' | 'crash' | null = null
    const watch = (async () => {
      while (!probe.signal.aborted) {
        await sleep(1200)
        if (this.cancelled) { fault = 'crash'; probe.abort(); return }
        const st = this.manager.status()
        if (st.state === 'error' || st.state === 'stopped') {
          fault = (st.err?.logTail ?? []).some((l) => OOM_RE.test(l)) ? 'oom' : 'crash'
          probe.abort(); return
        }
        // Engine still "running" but stuck mid-inference (graph-capture OOM, etc.) writes the fault
        // to its log without exiting — catch it from the live log so we don't wait out the budget.
        if (logPath && OOM_RE.test(readLiveTail(logPath))) { fault = 'oom'; probe.abort(); return }
      }
    })()

    let timed: { tps: number; ttftMs: number } | null = null
    try {
      timed = await this.chat(target, content, maxTokens, budgetMs, probe.signal)
    } catch {
      timed = null
    } finally {
      probe.abort()
      await watch.catch(() => {})
    }
    if (timed) return timed
    if (fault) return { fault }
    return { fault: this.cancelled ? 'crash' : 'timeout' }
  }

  /** Prefill gate: stream the bench prompt and watch how fast the prompt is processed. If the
   *  projected time to finish prefilling exceeds the per-test budget, the config is spilling to
   *  system memory / crawling — abort and mark it NG so the search offloads more, instead of waiting
   *  out the whole budget. Also aborts on an engine fault (OOM / "device not ready" / process death).
   *  Returns 'ok' once prefill completes (generation starts) — a config that gets here is viable and
   *  the warm prompt cache makes the following measured request fast and accurate. */
  private async prefillProbe(
    target: string,
    content: string,
    budgetMs: number,
    logPath: string,
    stepPrefix: string,
  ): Promise<'ok' | { fault: 'oom' | 'crash' | 'timeout' }> {
    const probe = new AbortController()
    let fault: 'oom' | 'crash' | null = null
    const watch = (async () => {
      while (!probe.signal.aborted) {
        await sleep(1200)
        if (this.cancelled) { fault = 'crash'; probe.abort(); return }
        const st = this.manager.status()
        if (st.state === 'error' || st.state === 'stopped') {
          fault = (st.err?.logTail ?? []).some((l) => OOM_RE.test(l)) ? 'oom' : 'crash'
          probe.abort(); return
        }
        if (logPath && OOM_RE.test(readLiveTail(logPath))) { fault = 'oom'; probe.abort(); return }
      }
    })()

    const signals: AbortSignal[] = [AbortSignal.timeout(budgetMs), probe.signal]
    if (this.abort) signals.push(this.abort.signal)
    const start = Date.now()
    let reachedGen = false
    try {
      const res = await fetch(`${target}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'bench', messages: [{ role: 'user', content }], max_tokens: 8, temperature: 0, seed: 42, stream: true, return_progress: true }),
        signal: AbortSignal.any(signals),
      })
      if (!res.ok || !res.body) throw new Error('no stream')
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') { reachedGen = true; break outer }
          let chunk: Record<string, unknown>
          try { chunk = JSON.parse(raw) } catch { continue }
          const pp = chunk.prompt_progress as { processed?: number; total?: number } | undefined
          if (pp?.total) {
            const processed = pp.processed ?? 0
            const pct = Math.round((processed / pp.total) * 100)
            this.state = { ...this.state, step: `${stepPrefix} — prefill ${pct}%` }
            const elapsed = Date.now() - start
            if (processed > 0 && elapsed > PREFILL_GRACE_MS && elapsed * (pp.total / processed) > budgetMs) {
              // Projected to overrun the budget → spilling/too slow for this ctx. NG.
              fault = 'oom'
              await reader.cancel().catch(() => {})
              break outer
            }
          }
          const delta = (chunk.choices as Array<{ delta?: { content?: string; reasoning_content?: string } }> | undefined)?.[0]?.delta
          if (delta && (delta.content || delta.reasoning_content)) { reachedGen = true; await reader.cancel().catch(() => {}); break outer }
        }
      }
    } catch {
      // aborted by fault watchdog / cancel / budget, or a transport error
    } finally {
      probe.abort()
      await watch.catch(() => {})
    }
    if (reachedGen) return 'ok'
    if (fault) return { fault }
    return { fault: this.cancelled ? 'crash' : 'timeout' }
  }

  /** One non-streaming /v1/chat/completions request. Returns engine-reported tps + ttftMs, or null.
   *  Aborts on the per-test timeout, the cancel kill-switch, or `extraSignal` (the fault watchdog). */
  private async chat(target: string, content: string, maxTokens: number, timeoutMs: number, extraSignal?: AbortSignal): Promise<{ tps: number; ttftMs: number } | null> {
    const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)]
    if (this.abort) signals.push(this.abort.signal)
    if (extraSignal) signals.push(extraSignal)
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
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
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

/** How many prompt tokens to use for a bench trial: 75% of the configured context, capped at
 *  50k tokens. The 0.75 factor keeps the prompt a realistic fraction of the window (leaving room
 *  for generation); the 50k cap stops very large-ctx models from spending the whole trial
 *  prefilling a huge prompt (which would risk the per-test timeout). KV/VRAM is allocated for the
 *  full ctx at load regardless, so this only sizes the prefill-speed measurement, not VRAM fit. */
function benchPromptTokens(ctx: number): number {
  return Math.max(256, Math.min(50_000, Math.floor(ctx * 0.75)))
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

/** Last ~8KB of a (possibly growing) log file as a string, or '' on error. Cheap enough to poll
 *  during readiness to catch an OOM the engine prints but hasn't crashed on yet. */
function readLiveTail(path: string): string {
  try {
    return readFileSync(path, 'utf8').slice(-8000)
  } catch {
    return ''
  }
}
