import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, RotateCcw, Save, Zap } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { useEngines, useModelActions, useModelDetail } from '../../lib/queries'
import type { LoadProfile } from '../../lib/types'
import { estimateVram } from '../../lib/vram'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'

export function ModelDetailDialog({ modelKey, onClose }: { modelKey: string | null; onClose: () => void }) {
  const detailQ = useModelDetail(modelKey)
  const enginesQ = useEngines()
  const actions = useModelActions()
  const [draft, setDraft] = useState<LoadProfile | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [remember, setRemember] = useState(true)

  const detail = detailQ.data
  useEffect(() => {
    if (detail) setDraft(structuredClone(detail.profile))
  }, [detail])

  const activeEngine = enginesQ.data?.engines.find((e) => e.id === enginesQ.data?.activeEngineId)
  const kvTypes = activeEngine?.capabilities.kvTypes ?? ['f16']

  // Speculative-decoding options: require BOTH engine capability AND model support
  // (spec 05 §8). MTP is a Gemma-4 feature; NextN is a Qwen3 feature; draft works
  // with any model (separate small draft GGUF).
  const flags = activeEngine?.capabilities.flags ?? []
  const hasFlag = (f: string) => flags.length === 0 || flags.includes(f)
  const arch = (detail?.arch ?? '').toLowerCase()
  const modelName = (detail?.name ?? '').toLowerCase()
  const modelSupportsMtp = /gemma4/.test(arch) || /gemma[ _-]?4/.test(modelName)
  const modelSupportsNextn = /qwen3/.test(arch) || /qwen[ _-]?3/.test(modelName)
  const specOptions: Array<LoadProfile['speculative']> = ['off']
  if (hasFlag('--spec-type') && hasFlag('--mtp-head') && modelSupportsMtp) specOptions.push('mtp')
  if (hasFlag('--spec-type') && hasFlag('--model-draft') && modelSupportsNextn) specOptions.push('nextn')
  if (hasFlag('--model-draft')) specOptions.push('draft')

  const fit = useMemo(() => {
    if (!detail || !draft) return null
    return estimateVram(draft, detail, detail.gpu?.vramMb ?? 0)
  }, [detail, draft])

  const set = <K extends keyof LoadProfile>(k: K, v: LoadProfile[K]) =>
    setDraft((d) => (d ? { ...d, [k]: v } : d))
  const setS = <K extends keyof LoadProfile['sampling']>(k: K, v: number) =>
    setDraft((d) => (d ? { ...d, sampling: { ...d.sampling, [k]: v } } : d))

  const loadError = actions.load.error instanceof ApiError ? actions.load.error.message : null

  return (
    <Dialog open={!!modelKey} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="truncate">{detail?.name ?? 'Model'}</DialogTitle>
          <DialogDescription>
            {detail ? `${detail.arch} · ${detail.quant} · ${fmtSize(detail.sizeBytes)}` : 'Load settings'}
          </DialogDescription>
        </DialogHeader>

        {!detail || !draft ? (
          <div className="py-10 text-center text-[13px] text-muted">Loading…</div>
        ) : (
          <div className="flex flex-col gap-4">
            {fit && <VramBar estMb={fit.estMb} totalMb={fit.totalVramMb} verdict={fit.verdict} />}

            <Section>
              <Slider label="Context length" hint="Tokens of history the model can use." value={draft.ctx} min={512} max={Math.max(512, detail.nativeCtx || 8192)} step={512} onChange={(v) => set('ctx', v)} fmt={(v) => v.toLocaleString()} />
              {detail.gpu && (
                <Slider label="GPU layers" hint="99 = all on GPU." value={draft.ngl} min={0} max={99} step={1} onChange={(v) => set('ngl', v)} fmt={(v) => (v >= 99 ? 'All' : String(v))} />
              )}
              {detail.moe && detail.blockCount > 0 && (
                <Slider label="MoE experts on CPU" hint="Higher = less VRAM, slower. Lower = faster if it fits." value={draft.nCpuMoe} min={0} max={detail.blockCount} step={1} onChange={(v) => set('nCpuMoe', v)} />
              )}
            </Section>

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
            </Section>

            <SectionTitle>Sampling</SectionTitle>
            <Section>
              <Slider label="Temperature" value={draft.sampling.temp} min={0} max={2} step={0.05} onChange={(v) => setS('temp', v)} fmt={(v) => v.toFixed(2)} />
              <Slider label="Top P" value={draft.sampling.topP} min={0} max={1} step={0.01} onChange={(v) => setS('topP', v)} fmt={(v) => v.toFixed(2)} />
              <Slider label="Top K" value={draft.sampling.topK} min={0} max={200} step={1} onChange={(v) => setS('topK', v)} />
              <Slider label="Min P" value={draft.sampling.minP} min={0} max={1} step={0.01} onChange={(v) => setS('minP', v)} fmt={(v) => v.toFixed(2)} />
            </Section>

            <button type="button" onClick={() => setAdvanced((a) => !a)} className="flex items-center gap-1 text-[13px] font-medium text-muted hover:text-ink">
              <ChevronDown size={14} className={advanced ? 'rotate-180 transition-transform' : 'transition-transform'} />
              Advanced
            </button>
            {advanced && (
              <Section>
                <Row label="Threads (0 = auto)">
                  <NumberInput value={draft.threads} min={0} max={64} onChange={(v) => set('threads', v)} />
                </Row>
                <Row label="Cache reuse">
                  <NumberInput value={draft.cacheReuse} min={0} max={4096} onChange={(v) => set('cacheReuse', v)} />
                </Row>
                <Toggle label="Apply chat template (--jinja)" value={draft.useJinja} onChange={(v) => set('useJinja', v)} />
                {detail.vision && <Toggle label="Vision encoder on GPU" value={draft.mmprojGpu} onChange={(v) => set('mmprojGpu', v)} />}
                {draft.parallel > 1 && <Toggle label="Unified KV across slots" value={draft.kvUnified} onChange={(v) => set('kvUnified', v)} />}

                {specOptions.length > 1 && (
                  <div className="flex flex-col gap-2 border-t border-border pt-3">
                    <Row label="Speculative decoding" hint="Predict several tokens per step — faster generation.">
                      <SpecSegmented value={draft.speculative} options={specOptions} onChange={(v) => set('speculative', v)} />
                    </Row>
                    {draft.speculative === 'mtp' && (
                      <PathField
                        label="MTP head GGUF"
                        hint="Gemma-4 gemma4_assistant model."
                        value={draft.mtpHeadPath}
                        placeholder="e.g. D:\\models\\gemma-4-mtp-assistant.gguf"
                        onChange={(v) => set('mtpHeadPath', v)}
                      />
                    )}
                    {draft.speculative === 'nextn' && (
                      <p className="text-[11px] text-faint">Uses this model’s built-in NextN head — no extra file needed.</p>
                    )}
                    {draft.speculative === 'draft' && (
                      <PathField
                        label="Draft model GGUF"
                        hint="A small same-family model."
                        value={draft.draftModelPath}
                        placeholder="e.g. D:\\models\\qwen3-0.6b.gguf"
                        onChange={(v) => set('draftModelPath', v)}
                      />
                    )}
                  </div>
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
                {remember ? '· saved as this model’s default' : '· this load only'}
              </span>
            </label>

            <div className="flex items-center gap-2">
              <Button
                className="flex-1"
                onClick={() => {
                  // Persist first when remembering, then (re)load, then close
                  // immediately — the engine reloads in the background.
                  if (remember) actions.save.mutate({ key: detail.key, profile: draft })
                  actions.load.mutate({ key: detail.key, overrides: draft })
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

function NumberInput({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      min={min}
      max={max}
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

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3">
      <span className="text-[13px] text-ink">{label}</span>
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
    </label>
  )
}

function fmtSize(b: number): string {
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`
}
