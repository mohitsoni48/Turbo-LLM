import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ExternalLink, Gauge, RotateCcw, Save, X, Zap } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { useBenchActions, useBenchState, useEngines, useModelActions, useModelDetail, useStatus } from '../../lib/queries'
import type { LoadProfile, SysGpu } from '../../lib/types'
import { defaultGpu } from '../../lib/types'
import { estimateVram, gpuBudgetMb } from '../../lib/vram'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { toast } from '../../components/ui/sonner'

export function ModelDetailDialog({
  modelKey,
  onClose,
  onViewRepo,
}: {
  modelKey: string | null
  onClose: () => void
  /** Open the model's Hugging Face page (card + quants) for the given repo. */
  onViewRepo?: (repo: string) => void
}) {
  const detailQ = useModelDetail(modelKey)
  const enginesQ = useEngines()
  const actions = useModelActions()
  const bench = useBenchActions()
  const benchState = useBenchState()
  const [pendingBenchKey, setPendingBenchKey] = useState<string | null>(null)
  const [draft, setDraft] = useState<LoadProfile | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [remember, setRemember] = useState(true)
  const qc = useQueryClient()

  const detail = detailQ.data
  const statusQ = useStatus()
  const engineState = statusQ.data?.engine.state
  useEffect(() => {
    if (detail) setDraft(structuredClone(detail.profile))
  }, [detail])

  // After "Stop & benchmark", the eject takes a moment to drain the engine. Once the
  // status poll reports it stopped, fire the deferred sweep (the runner 409s while busy).
  useEffect(() => {
    if (pendingBenchKey && (engineState === 'stopped' || engineState === 'error')) {
      bench.start.mutate({ key: pendingBenchKey, base: draft ?? undefined })
      setPendingBenchKey(null)
    }
  }, [pendingBenchKey, engineState, bench.start])

  const activeEngine = enginesQ.data?.engines.find((e) => e.id === enginesQ.data?.activeEngineId)
  const kvTypes = activeEngine?.capabilities.kvTypes ?? ['f16']

  // Speculative-decoding options: require BOTH engine capability AND model support
  // (spec 05 §8). MTP is a Gemma-4 feature; NextN is a Qwen3 feature; draft works
  // with any model (separate small draft GGUF).
  const flags = activeEngine?.capabilities.flags ?? []
  const hasFlag = (f: string) => flags.length === 0 || flags.includes(f)
  // Whether the engine accepts a given `--spec-type` value (probe captures these
  // as `spec-type:<value>`). Official llama.cpp lacks `nextn`; forks may add it.
  const specAccepts = (v: string) => flags.length === 0 || flags.includes(`spec-type:${v}`)
  const arch = (detail?.arch ?? '').toLowerCase()
  const modelName = (detail?.name ?? '').toLowerCase()
  // MTP uses a SEPARATE Gemma-4 assistant head GGUF the user supplies, so it's gated
  // on arch (an opt-in the user configures with --mtp-head). NextN uses the model's
  // OWN built-in head, so it's gated on real GGUF metadata (`nextn_predict_layers`).
  const modelSupportsMtp = /gemma4/.test(arch) || /gemma[ _-]?4/.test(modelName)
  const modelSupportsNextn = (detail?.nextnLayers ?? 0) > 0
  const specOptions: Array<LoadProfile['speculative']> = ['off']
  if (hasFlag('--spec-type') && hasFlag('--mtp-head') && modelSupportsMtp) specOptions.push('mtp')
  // NextN = the model's built-in head as a self-draft. The fork's spec-type is
  // `nextn`; mainline llama.cpp's equivalent is `draft-mtp` — accept either.
  if (
    hasFlag('--spec-type') &&
    hasFlag('--model-draft') &&
    modelSupportsNextn &&
    (specAccepts('nextn') || specAccepts('draft-mtp'))
  )
    specOptions.push('nextn')
  if (hasFlag('--model-draft')) specOptions.push('draft')

  const fit = useMemo(() => {
    if (!detail || !draft) return null
    // Budget spans all GPUs the chosen split uses (ADR-054), not just GPU 0.
    return estimateVram(draft, detail, gpuBudgetMb(detail.gpus ?? [], draft.gpu))
  }, [detail, draft])

  const set = <K extends keyof LoadProfile>(k: K, v: LoadProfile[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d))
  const setS = <K extends keyof LoadProfile['sampling']>(k: K, v: number) =>
    setDraft((d) => (d ? { ...d, sampling: { ...d.sampling, [k]: v } } : d))
  const setG = <K extends keyof LoadProfile['gpu']>(k: K, v: LoadProfile['gpu'][K]) =>
    setDraft((d) => (d ? { ...d, gpu: { ...(d.gpu ?? defaultGpu()), [k]: v } } : d))

  const loadError = actions.load.error instanceof ApiError ? actions.load.error.message : null

  // Auto-tune (spec 09 §1). A run owns the engine exclusively, so a loaded model must
  // be stopped first — the button offers "Stop & benchmark" when this model is loaded.
  // `benchHere` is true only when the active run targets THIS dialog's model, so the
  // inline progress / result never bleeds across models.
  const benchHere = !!benchState && benchState.modelKey === detail?.key
  const benchRunning = !!benchState?.running && benchHere
  const benchDone = !!benchState?.done && benchHere && !benchState.running
  const benchErr = bench.start.error instanceof ApiError ? bench.start.error.message : null
  const isMlx = detail?.format === 'mlx'
  // The runner requires a free engine (409 otherwise). When this model is loaded,
  // stop it first, then start the sweep once the engine has settled.
  const startBenchRun = () => {
    if (!detail) return
    if (detail.loaded) {
      // Stop the engine; the effect above starts the sweep once it reports stopped.
      setPendingBenchKey(detail.key)
      actions.eject.mutate()
    } else {
      bench.start.mutate({ key: detail.key, base: draft ?? undefined })
    }
  }

  // When a sweep finishes it saves the tuned profile server-side — refetch the detail
  // so the form reflects the new settings immediately (no close/reopen needed).
  useEffect(() => {
    if (benchDone && detail?.key) {
      void qc.invalidateQueries({ queryKey: ['model', detail.key] })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [benchDone, detail?.key])

  return (
    <Dialog open={!!modelKey} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="truncate">{detail?.name ?? 'Model'}</DialogTitle>
          <DialogDescription>
            {detail ? `${detail.arch} · ${detail.quant} · ${fmtSize(detail.sizeBytes)}` : 'Load settings'}
          </DialogDescription>
          {detail?.sourceRepo && onViewRepo && (
            <button
              type="button"
              onClick={() => onViewRepo(detail.sourceRepo!)}
              className="mt-1 inline-flex w-fit items-center gap-1 text-[12px] font-medium text-accent hover:underline"
              title={`View ${detail.sourceRepo} on Hugging Face`}
            >
              <ExternalLink size={12} /> Model card &amp; quants on Hugging Face
            </button>
          )}
        </DialogHeader>

        {!detail || !draft ? (
          <div className="py-10 text-center text-[13px] text-muted">Loading…</div>
        ) : (
          <div className="flex flex-col gap-4">
            {fit && <VramBar estMb={fit.estMb} totalMb={fit.totalVramMb} verdict={fit.verdict} />}

            {!isMlx && detail.gpu && (
              <AutoTune
                running={benchRunning}
                done={benchDone}
                step={benchHere ? benchState?.step : undefined}
                bestTps={benchHere ? benchState?.bestTps : undefined}
                resultError={benchDone ? benchState?.error : undefined}
                benchTps={detail.benchTps}
                tuned={draft.tunedBy === 'bench'}
                loaded={detail.loaded}
                startError={benchErr}
                pending={bench.start.isPending || pendingBenchKey !== null}
                onStart={startBenchRun}
                onCancel={() => bench.cancel.mutate()}
              />
            )}

            <Section>
              <Slider label="Context length" hint="Tokens of history the model can use." value={draft.ctx} min={512} max={Math.max(512, detail.nativeCtx || 8192)} step={512} onChange={(v) => set('ctx', v)} fmt={(v) => v.toLocaleString()} />
              {detail.gpu && (
                <Slider label="GPU layers" hint="99 = all on GPU." value={draft.ngl} min={0} max={99} step={1} onChange={(v) => set('ngl', v)} fmt={(v) => (v >= 99 ? 'All' : String(v))} />
              )}
              {detail.moe && detail.blockCount > 0 && (
                <Slider label="MoE experts on CPU" hint="Higher = less VRAM, slower. Lower = faster if it fits." value={draft.nCpuMoe} min={0} max={detail.blockCount} step={1} onChange={(v) => set('nCpuMoe', v)} />
              )}
              <Row label="Context overflow" hint="What to do when the context window fills up.">
                <Segmented
                  value={draft.contextOverflow}
                  options={['shift', 'keep']}
                  onChange={(v) => set('contextOverflow', v as LoadProfile['contextOverflow'])}
                />
              </Row>
              {draft.contextOverflow === 'keep' && (
                <Row label="Tokens to keep" hint="Preserve this many tokens from the start (e.g. system prompt length) when shifting.">
                  <NumberInput value={draft.nKeep} min={0} max={draft.ctx} onChange={(v) => set('nKeep', v)} />
                </Row>
              )}
            </Section>

            {/* Multi-GPU split (ADR-054) — only when more than one GPU and a GPU engine. */}
            {detail.gpus && detail.gpus.length > 1 && (activeEngine?.kind === 'llama-server' || activeEngine?.kind === 'vllm') && (
              <>
                <SectionTitle>Multi-GPU · {detail.gpus.length} GPUs</SectionTitle>
                <Section>
                  {activeEngine.kind === 'vllm' ? (
                    <Row label="Tensor parallel size" hint="Shard the model across this many GPUs.">
                      <NumberInput value={draft.gpu?.tensorParallelSize ?? 1} min={1} max={detail.gpus.length} onChange={(v) => setG('tensorParallelSize', v)} />
                    </Row>
                  ) : (
                    <GpuSplitControls gpus={detail.gpus} gpu={draft.gpu ?? defaultGpu()} setG={setG} />
                  )}
                </Section>
              </>
            )}

            <Section>
              <Row label="Parallel slots">
                <NumberInput value={draft.parallel} min={1} max={16} onChange={(v) => set('parallel', v)} />
              </Row>
              <Row label="KV cache type" hint="turbo* are TurboQuant-fork exclusive.">
                <Select value={draft.kvTypeK} options={kvTypes} onChange={(v) => setDraft((d) => (d ? { ...d, kvTypeK: v, kvTypeV: v } : d))} />
              </Row>
              <Row label="Flash attention">
                <Segmented value={draft.flashAttn} options={['auto', 'on', 'off']} onChange={(v) => set('flashAttn', v as LoadProfile['flashAttn'])} />
              </Row>
              <Toggle label="Use Jinja chat template" value={draft.useJinja} onChange={(v) => set('useJinja', v)} />
              {draft.useJinja && (
                <PathField
                  label="Template file path (optional)"
                  hint="Leave empty to use model's built-in template."
                  value={draft.chatTemplateFile}
                  placeholder="Path to .jinja template file"
                  onChange={(v) => set('chatTemplateFile', v)}
                />
              )}
            </Section>

            <SectionTitle>Sampling</SectionTitle>
            <Section>
              <Slider label="Temperature" value={draft.sampling.temp} min={0} max={2} step={0.05} onChange={(v) => setS('temp', v)} fmt={(v) => v.toFixed(2)} />
              <Slider label="Top P" value={draft.sampling.topP} min={0} max={1} step={0.01} onChange={(v) => setS('topP', v)} fmt={(v) => v.toFixed(2)} />
              <Slider label="Top K" value={draft.sampling.topK} min={0} max={200} step={1} onChange={(v) => setS('topK', v)} />
              <Slider label="Min P" value={draft.sampling.minP} min={0} max={1} step={0.01} onChange={(v) => setS('minP', v)} fmt={(v) => v.toFixed(2)} />
              <Slider label="Repeat penalty" hint="Penalise tokens that appeared earlier. 1.0 = off." value={draft.sampling.repeatPenalty} min={1} max={2} step={0.05} onChange={(v) => setS('repeatPenalty', v)} fmt={(v) => v.toFixed(2)} />
              <Slider label="Presence penalty" hint="Flat penalty for any token that appeared. 0 = off." value={draft.sampling.presencePenalty} min={0} max={2} step={0.05} onChange={(v) => setS('presencePenalty', v)} fmt={(v) => v.toFixed(2)} />
              <Slider label="Frequency penalty" hint="Penalty proportional to how often a token appeared. 0 = off." value={draft.sampling.frequencyPenalty} min={0} max={2} step={0.05} onChange={(v) => setS('frequencyPenalty', v)} fmt={(v) => v.toFixed(2)} />
              <Row label="Stop strings" hint="Halt generation when any of these sequences is produced.">
                <div className="w-full" />
              </Row>
              <StopStringInput
                value={draft.sampling.stop}
                onChange={(v) => setDraft((d) => d ? { ...d, sampling: { ...d.sampling, stop: v } } : d)}
              />
            </Section>

            {specOptions.length > 1 && (
              <>
                <SectionTitle>Speculative decoding</SectionTitle>
                <Section>
                  <Row label="Mode" hint="Predict extra tokens per step — faster generation.">
                    <SpecSegmented value={draft.speculative} options={specOptions} onChange={(v) => set('speculative', v)} />
                  </Row>
                  {draft.speculative === 'mtp' && (
                    <PathField
                      label="MTP head GGUF"
                      hint="Gemma-4 assistant model file."
                      value={draft.mtpHeadPath}
                      placeholder="Path to gemma-4-mtp-assistant.gguf"
                      onChange={(v) => set('mtpHeadPath', v)}
                    />
                  )}
                  {draft.speculative === 'nextn' && (
                    <p className="text-[11px] text-faint">Uses this model's built-in NextN head — no extra file needed.</p>
                  )}
                  {draft.speculative === 'draft' && (
                    <PathField
                      label="Draft model GGUF"
                      hint="A small same-family model."
                      value={draft.draftModelPath}
                      placeholder="Path to small draft model"
                      onChange={(v) => set('draftModelPath', v)}
                    />
                  )}
                </Section>
              </>
            )}

            <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex items-center gap-1 text-[13px] font-medium text-muted hover:text-ink">
              <ChevronDown size={14} className={advanced ? 'rotate-180 transition-transform' : 'transition-transform'} />
              Advanced
            </button>
            {advanced && (
              <Section>
                <Slider
                  label="CPU threads"
                  hint={
                    draft.threads === 0
                      ? `Auto — half your cores (${autoThreads(detail.cores)} of ${detail.cores || '?'})`
                      : `${draft.threads} of ${detail.cores || '?'} cores`
                  }
                  value={draft.threads}
                  min={0}
                  max={Math.max(1, detail.cores || 64)}
                  step={1}
                  onChange={(v) => set('threads', v)}
                  fmt={(v) => (v === 0 ? 'Auto' : String(v))}
                />
                <Toggle
                  label="Reuse cached prompt"
                  hint="Skips re-processing the unchanged start of a prompt on repeated or continued requests — faster first token. Recommended on."
                  value={draft.cacheReuse > 0}
                  onChange={(on) => set('cacheReuse', on ? 256 : 0)}
                />
                {detail.vision && <Toggle label="Vision encoder on GPU" value={draft.mmprojGpu} onChange={(v) => set('mmprojGpu', v)} />}
                {draft.parallel > 1 && <Toggle label="Unified KV across slots" value={draft.kvUnified} onChange={(v) => set('kvUnified', v)} />}
                <Row label="RoPE scaling" hint="Extend context beyond the model's trained limit. 'none' = model native.">
                  <Segmented
                    value={draft.ropeScalingType}
                    options={['none', 'linear', 'yarn']}
                    onChange={(v) => set('ropeScalingType', v as LoadProfile['ropeScalingType'])}
                  />
                </Row>
                {draft.ropeScalingType !== 'none' && (
                  <>
                    <Row label="RoPE freq base" hint="Base frequency override. 0 = model native.">
                      <NumberInput value={draft.ropeFreqBase} min={0} max={10_000_000} onChange={(v) => set('ropeFreqBase', v)} />
                    </Row>
                    <Row label="RoPE freq scale" hint="Frequency scale. 0 = model native; e.g. 0.25 for 4× context.">
                      <NumberInput value={draft.ropeFreqScale} min={0} max={10} step={0.01} onChange={(v) => set('ropeFreqScale', v)} />
                    </Row>
                  </>
                )}
              </Section>
            )}

            {loadError && <p className="text-[12px]" style={{ color: 'var(--err)' }}>{loadError}</p>}

            <label className="flex cursor-pointer items-center gap-2 pt-1 text-[13px] text-ink">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              Remember these settings
              <span className="text-[11px] text-faint">
                {remember ? "· saved as this model's default" : '· this load only'}
              </span>
            </label>

            <div className="flex items-center gap-2">
              <Button
                className="flex-1"
                onClick={() => {
                  // Sequence: persist (when remembering) → then (re)load. Firing both
                  // at once raced the profile write against the reload. The reload
                  // surfaces failures via toast — otherwise a bad param silently stops
                  // the engine and the model "never loads again" with no feedback.
                  const fireLoad = () =>
                    actions.load.mutate(
                      { key: detail.key, overrides: draft },
                      {
                        onError: (e) =>
                          toast.error(
                            e instanceof ApiError
                              ? `Could not load model: ${e.message}`
                              : 'Could not load model — check the engine logs on the Engines screen.',
                          ),
                      },
                    )
                  if (remember) {
                    actions.save.mutate({ key: detail.key, profile: draft }, { onSuccess: fireLoad, onError: fireLoad })
                  } else {
                    fireLoad()
                  }
                  onClose()
                }}
                disabled={actions.load.isPending}
              >
                <Zap size={14} />
                {detail.loaded ? 'Reload' : 'Load model'}
              </Button>
              <Button variant="outline" onClick={() => actions.save.mutate({ key: detail.key, profile: draft })} disabled={actions.save.isPending} title="Save without reloading">
                <Save size={14} />
                Save
              </Button>
              <Button variant="ghost" onClick={() => actions.reset.mutate(detail.key)} disabled={actions.reset.isPending} title="Reset to defaults">
                <RotateCcw size={14} />
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ── VRAM bar (spec 05 §6 verdict colors) ─────────────────────────────────────
function VramBar({ estMb, totalMb, verdict }: { estMb: number; totalMb: number; verdict: string }) {
  if (verdict === 'cpu' || totalMb === 0) {
    return <div className="rounded-md border border-border bg-panel-2 px-3 py-2 text-[12px] text-muted">CPU-only — no GPU detected.</div>
  }
  const color = verdict === 'fits' ? 'var(--ok)' : verdict === 'tight' ? 'var(--warn)' : 'var(--err)'
  const pct = Math.min(100, Math.round((estMb / totalMb) * 100))
  const label = verdict === 'overflow' ? 'will spill to system RAM — expect severe slowdown' : verdict === 'tight' ? 'may slow under desktop load' : 'fits comfortably'
  return (
    <div className="rounded-md border border-border bg-panel-2 px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between text-[12px]">
        <span className="text-muted">Estimated VRAM</span>
        <span style={{ color }}>~{(estMb / 1000).toFixed(1)} / {(totalMb / 1000).toFixed(1)} GB · {label}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--border)' }}>
        <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

// ── Auto-tune card (spec 09 §1): one button → inline mini-log + cancel → result ──
function AutoTune({
  running, done, step, bestTps, resultError, benchTps, tuned, loaded, startError, pending, onStart, onCancel,
}: {
  running: boolean
  done: boolean
  step?: string
  bestTps?: number
  resultError?: string
  benchTps: number | null
  tuned: boolean
  loaded: boolean
  startError: string | null
  pending: boolean
  onStart: () => void
  onCancel: () => void
}) {
  return (
    <div className="rounded-lg border border-border bg-panel p-3">
      {running ? (
        // Live mini-log: current step + best-so-far, with a Cancel button.
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[13px] text-ink">
              <Gauge size={14} className="animate-pulse" style={{ color: 'var(--accent)' }} />
              Auto-tuning…
            </div>
            <Button variant="outline" onClick={onCancel}>
              <X size={14} />
              Cancel
            </Button>
          </div>
          <p className="font-mono text-[12px] text-muted">{step ?? 'Preparing…'}</p>
          {bestTps !== undefined && (
            <p className="text-[12px] text-ink">Best so far: <span className="font-mono" style={{ color: 'var(--ok)' }}>{bestTps.toFixed(1)} tok/s</span></p>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[13px] font-medium text-ink">
                <Gauge size={14} style={{ color: 'var(--accent)' }} />
                Auto-tune
              </div>
              <p className="text-[11px] text-faint">
                {benchTps !== null
                  ? `Tuned: ${benchTps.toFixed(1)} tok/s on your machine${tuned ? ' · settings applied below' : ''}`
                  : 'Measures real speed on your hardware and saves the fastest settings (~3 min).'}
              </p>
            </div>
            <Button variant="outline" onClick={onStart} disabled={pending}>
              <Zap size={14} />
              {loaded ? 'Stop & benchmark' : 'Auto-tune'}
            </Button>
          </div>
          {done && bestTps !== undefined && !resultError && (
            <p className="text-[12px] text-ink">Done — <span className="font-mono" style={{ color: 'var(--ok)' }}>{bestTps.toFixed(1)} tok/s</span>. Saved as this model's default.</p>
          )}
          {done && resultError && <p className="text-[12px]" style={{ color: 'var(--warn)' }}>{resultError}</p>}
          {startError && <p className="text-[12px]" style={{ color: 'var(--err)' }}>{startError}</p>}
        </div>
      )}
    </div>
  )
}

// ── small form primitives (native inputs, design-token styled) ───────────────
function Section({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-3">{children}</div>
}
function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="text-[12px] font-semibold uppercase tracking-wide text-faint">{children}</div>
}

function Slider({ label, hint, value, min, max, step, onChange, fmt }: {
  label: string; hint?: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; fmt?: (v: number) => string
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[13px] text-ink">{label}</span>
        <span className="font-mono text-[12px] text-muted">{fmt ? fmt(value) : value}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
      {hint && <p className="mt-0.5 text-[11px] text-faint">{hint}</p>}
    </div>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <div className="text-[13px] text-ink">{label}</div>
        {hint && <div className="text-[11px] text-faint">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function NumberInput({ value, min, max, step = 1, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
      className="w-20 rounded-md border border-border bg-bg px-2 py-1 text-right text-[13px] text-ink outline-none"
    />
  )
}

function Select({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-md border border-border bg-bg px-2 py-1 text-[13px] text-ink outline-none">
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  )
}

function Segmented({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <div className="flex overflow-hidden rounded-md border border-border">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className="px-2.5 py-1 text-[12px] capitalize transition-colors"
          style={{ background: value === o ? 'var(--accent)' : 'transparent', color: value === o ? 'var(--on-accent)' : 'var(--muted)' }}
        >
          {o}
        </button>
      ))}
    </div>
  )
}

/** A GPU label like "GPU 0 · NVIDIA RTX 5070 Ti (16 GB)". */
function fmtGpu(g: SysGpu, i: number): string {
  const vram = g.vramMb ? ` (${Math.round(g.vramMb / 1024)} GB)` : ''
  return `GPU ${i}${g.name ? ` · ${g.name}` : ''}${vram}`
}

/** Native select over GPU indices; `allowAuto` adds an Auto (-1) option. */
function GpuPicker({ gpus, value, allowAuto, onChange }: {
  gpus: SysGpu[]; value: number; allowAuto: boolean; onChange: (i: number) => void
}) {
  return (
    <select
      value={String(value)}
      onChange={(e) => onChange(Number(e.target.value))}
      className="max-w-[260px] rounded-md border border-border bg-bg px-2 py-1 text-[13px] text-ink outline-none"
    >
      {allowAuto && <option value="-1">Auto</option>}
      {gpus.map((g, i) => (
        <option key={i} value={String(i)}>{fmtGpu(g, i)}</option>
      ))}
    </select>
  )
}

/** llama.cpp / TurboQuant multi-GPU controls: split mode + main GPU + optional
 *  per-GPU tensor-split proportions (ADR-054). */
function GpuSplitControls({ gpus, gpu, setG }: {
  gpus: SysGpu[]
  gpu: LoadProfile['gpu']
  setG: <K extends keyof LoadProfile['gpu']>(k: K, v: LoadProfile['gpu'][K]) => void
}) {
  const custom = gpu.tensorSplit.length > 0
  return (
    <>
      <Row label="Split mode" hint="layer = by layers (default) · row = tensor-parallel · none = single GPU.">
        <Segmented value={gpu.splitMode} options={['layer', 'row', 'none']} onChange={(v) => setG('splitMode', v as LoadProfile['gpu']['splitMode'])} />
      </Row>
      {gpu.splitMode === 'none' ? (
        <Row label="GPU" hint="Which GPU to load the model on.">
          <GpuPicker gpus={gpus} value={gpu.mainGpu >= 0 ? gpu.mainGpu : 0} allowAuto={false} onChange={(i) => setG('mainGpu', i)} />
        </Row>
      ) : (
        <>
          <Row label="Main GPU" hint="Holds the KV cache / small tensors. Auto lets the engine choose.">
            <GpuPicker gpus={gpus} value={gpu.mainGpu} allowAuto onChange={(i) => setG('mainGpu', i)} />
          </Row>
          <Toggle
            label="Custom GPU split"
            hint="Off = even split across GPUs. On = set each GPU's share."
            value={custom}
            onChange={(on) => setG('tensorSplit', on ? gpus.map(() => 1) : [])}
          />
          {custom && (
            <div className="flex flex-col gap-2 pl-1">
              {gpus.map((g, i) => (
                <Row key={i} label={fmtGpu(g, i)}>
                  <NumberInput
                    value={gpu.tensorSplit[i] ?? 0}
                    min={0}
                    max={100}
                    onChange={(v) => setG('tensorSplit', gpus.map((_, j) => (j === i ? v : gpu.tensorSplit[j] ?? 0)))}
                  />
                </Row>
              ))}
            </div>
          )}
        </>
      )}
    </>
  )
}

const SPEC_LABEL: Record<LoadProfile['speculative'], string> = { off: 'Off', mtp: 'MTP', nextn: 'NextN', draft: 'Draft' }

function SpecSegmented({ value, options, onChange }: {
  value: LoadProfile['speculative']; options: Array<LoadProfile['speculative']>; onChange: (v: LoadProfile['speculative']) => void
}) {
  return (
    <div className="flex overflow-hidden rounded-md border border-border">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(o)}
          className="px-2.5 py-1 text-[12px] transition-colors"
          style={{ background: value === o ? 'var(--accent)' : 'transparent', color: value === o ? 'var(--on-accent)' : 'var(--muted)' }}
        >
          {SPEC_LABEL[o]}
        </button>
      ))}
    </div>
  )
}

function PathField({ label, hint, value, placeholder, onChange }: {
  label: string; hint?: string; value: string; placeholder?: string; onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[12px] text-ink">{label}{hint && <span className="ml-1 text-faint">{hint}</span>}</div>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-md border border-border bg-bg px-2 py-1 font-mono text-[12px] text-ink outline-none placeholder:text-faint"
      />
    </div>
  )
}

function StopStringInput({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [input, setInput] = useState('')
  const add = (s: string) => {
    const t = s.trim()
    if (t && !value.includes(t)) onChange([...value, t])
    setInput('')
  }
  return (
    <div className="flex flex-col gap-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((s) => (
            <span key={s} className="flex items-center gap-0.5 rounded border border-border bg-panel-2 px-1.5 py-0.5 font-mono text-[11px] text-ink">
              {s}
              <button type="button" onClick={() => onChange(value.filter((v) => v !== s))} className="ml-0.5 text-muted hover:text-[var(--err)]">×</button>
            </span>
          ))}
        </div>
      )}
      <input
        type="text"
        value={input}
        placeholder={value.length ? 'Add another…' : 'Type a stop string, press Enter'}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add(input) }
          if (e.key === 'Backspace' && !input && value.length) onChange(value.slice(0, -1))
        }}
        onBlur={() => { if (input.trim()) add(input) }}
        className="w-full rounded-md border border-border bg-bg px-2 py-1 font-mono text-[12px] text-ink outline-none placeholder:text-faint"
      />
    </div>
  )
}

function Toggle({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <div className="min-w-0">
        <span className="text-[13px] text-ink">{label}</span>
        {hint && <p className="text-[11px] text-faint">{hint}</p>}
      </div>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 shrink-0 accent-[var(--accent)]" />
    </label>
  )
}

/** Effective threads when "Auto" (0) is chosen — half the logical cores. */
function autoThreads(cores: number): number {
  return Math.max(1, Math.floor((cores || 2) / 2))
}

function fmtSize(b: number): string {
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`
}
