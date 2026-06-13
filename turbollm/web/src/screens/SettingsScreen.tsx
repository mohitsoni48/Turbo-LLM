import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Moon, Sun, Monitor, Save, ExternalLink, ShieldAlert, Sparkles } from 'lucide-react'
import { ScreenHeader } from '../components/common'
import { Button } from '../components/ui/button'
import { useUiStore, type Theme } from '../stores/ui'
import { useNetworkInfo, useSettings, useStatus, useSysInfo, useTelemetryPreview } from '../lib/queries'
import { useConversationMutations } from '../lib/chat-queries'
import { ApiError, type TelemetryLevel } from '../lib/api'
import { toast } from '../components/ui/sonner'

export function SettingsScreen() {
  const { theme, setTheme } = useUiStore()
  const { query: settingsQ, save } = useSettings()
  const settings = settingsQ.data

  const [ttl, setTtl] = useState<number>(60)
  const [autoTitle, setAutoTitle] = useState(true)
  const [openBrowser, setOpenBrowser] = useState(true)
  const [autoLoad, setAutoLoad] = useState(false)
  const [defCtx, setDefCtx] = useState<number>(8192)
  const [defNgl, setDefNgl] = useState<number>(99)
  const [defImageMax, setDefImageMax] = useState<number>(0)
  const [telemetry, setTelemetry] = useState<TelemetryLevel>('off')
  const [lanBind, setLanBind] = useState(false)

  useEffect(() => {
    if (settings) {
      setTtl(settings.idleTtlMinutes)
      setAutoTitle(settings.autoGenerateTitles)
      setOpenBrowser(settings.openBrowserOnStart)
      setAutoLoad(settings.autoLoadOnStart ?? false)
      setDefCtx(settings.modelDefaults?.ctx ?? 8192)
      setDefNgl(settings.modelDefaults?.ngl ?? 99)
      setDefImageMax(settings.modelDefaults?.imageMaxTokens ?? 0)
      setTelemetry(settings.telemetryLevel ?? 'off')
      setLanBind(settings.lanBind ?? false)
    }
  }, [settings])

  const handleSave = () => {
    save.mutate(
      {
        idleTtlMinutes: ttl,
        autoGenerateTitles: autoTitle,
        openBrowserOnStart: openBrowser,
        autoLoadOnStart: autoLoad,
        telemetryLevel: telemetry,
        lanBind,
        modelDefaults: { ctx: defCtx, ngl: defNgl, imageMaxTokens: defImageMax },
      },
      {
        onSuccess: () => toast.success('Settings saved'),
        onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save settings.'),
      },
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <ScreenHeader title="Settings" description="Configure TurboLLM behavior and appearance." />

      <div className="flex flex-col gap-6">

        {/* TurboLLM Expert (spec 08 §2) */}
        <ExpertSection />

        {/* Theme */}
        <section className="rounded-lg border border-border bg-panel p-4">
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Appearance</h2>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-[14px] font-medium text-ink">Theme</div>
              <div className="text-[12px] text-muted">Choose light, dark, or follow your system setting</div>
            </div>
            <div className="flex overflow-hidden rounded-lg border border-border">
              {([
                { value: 'light', label: 'Light', Icon: Sun },
                { value: 'system', label: 'System', Icon: Monitor },
                { value: 'dark', label: 'Dark', Icon: Moon },
              ] as { value: Theme; label: string; Icon: React.ElementType }[]).map(({ value, label, Icon }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setTheme(value)}
                  className="flex items-center gap-1.5 px-3 py-2 text-[13px] transition-colors"
                  style={{
                    background: theme === value ? 'var(--accent)' : 'transparent',
                    color: theme === value ? 'var(--on-accent)' : 'var(--muted)',
                  }}
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Engine */}
        <section className="rounded-lg border border-border bg-panel p-4">
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Engine</h2>

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-[14px] font-medium text-ink">Idle timeout</div>
              <div className="text-[12px] text-muted">Unload model after this many minutes of inactivity (0 = never)</div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={1440}
                value={ttl}
                onChange={(e) => setTtl(Math.max(0, Math.min(1440, Number(e.target.value) || 0)))}
                className="w-20 rounded-md border border-border bg-bg px-2 py-1 text-right text-[13px] text-ink outline-none"
              />
              <span className="text-[12px] text-muted">min</span>
            </div>
          </div>
        </section>

        {/* Model Defaults (spec 05 §3) */}
        <section className="rounded-lg border border-border bg-panel p-4">
          <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">Model Defaults</h2>
          <p className="mb-3 text-[12px] text-muted">
            Applied the first time a model is loaded. A model's own saved settings always
            override these.
          </p>

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-[14px] font-medium text-ink">Context length</div>
              <div className="text-[12px] text-muted">Default context window, capped at each model's native max</div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={256}
                step={512}
                value={defCtx}
                onChange={(e) => setDefCtx(Math.max(256, Number(e.target.value) || 256))}
                className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-right text-[13px] text-ink outline-none"
              />
              <span className="text-[12px] text-muted">tok</span>
            </div>
          </div>

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-[14px] font-medium text-ink">GPU layers</div>
              <div className="text-[12px] text-muted">Layers to offload to the GPU (99 = all); ignored on CPU-only machines</div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                max={99}
                value={defNgl}
                onChange={(e) => setDefNgl(Math.max(0, Math.min(99, Number(e.target.value) || 0)))}
                className="w-20 rounded-md border border-border bg-bg px-2 py-1 text-right text-[13px] text-ink outline-none"
              />
            </div>
          </div>

          <div className="flex items-center justify-between py-2">
            <div>
              <div className="text-[14px] font-medium text-ink">Image max tokens</div>
              <div className="text-[12px] text-muted">Per-image token budget for vision models (0 = engine default)</div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                step={256}
                value={defImageMax}
                onChange={(e) => setDefImageMax(Math.max(0, Number(e.target.value) || 0))}
                className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-right text-[13px] text-ink outline-none"
              />
              <span className="text-[12px] text-muted">tok</span>
            </div>
          </div>
        </section>

        {/* Chat */}
        <section className="rounded-lg border border-border bg-panel p-4">
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Chat</h2>

          <label className="flex cursor-pointer items-center justify-between py-2">
            <div>
              <div className="text-[14px] font-medium text-ink">Auto-generate chat titles</div>
              <div className="text-[12px] text-muted">Uses the model to create a title after the first exchange</div>
            </div>
            <input
              type="checkbox"
              checked={autoTitle}
              onChange={(e) => setAutoTitle(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent)]"
            />
          </label>
        </section>

        {/* Startup */}
        <section className="rounded-lg border border-border bg-panel p-4">
          <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Startup</h2>

          <label className="flex cursor-pointer items-center justify-between py-2">
            <div>
              <div className="text-[14px] font-medium text-ink">Open browser on start</div>
              <div className="text-[12px] text-muted">Automatically open the UI when the daemon starts</div>
            </div>
            <input
              type="checkbox"
              checked={openBrowser}
              onChange={(e) => setOpenBrowser(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent)]"
            />
          </label>

          <label className="flex cursor-pointer items-center justify-between py-2">
            <div>
              <div className="text-[14px] font-medium text-ink">Auto-load last model</div>
              <div className="text-[12px] text-muted">Reload the last-used model automatically when the daemon starts</div>
            </div>
            <input
              type="checkbox"
              checked={autoLoad}
              onChange={(e) => setAutoLoad(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent)]"
            />
          </label>
        </section>

        {/* Network (spec 08 §2) */}
        <NetworkSection lanBind={lanBind} setLanBind={setLanBind} />

        {/* Privacy & telemetry (spec 09 §5) */}
        <PrivacySection level={telemetry} setLevel={setTelemetry} />

        {/* Hardware */}
        <HardwarePanel />

        {/* Save */}
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={save.isPending || settingsQ.isLoading}>
            <Save size={14} />
            {save.isPending ? 'Saving…' : 'Save settings'}
          </Button>
        </div>

        {/* Help */}
        <HelpSection />
      </div>
    </div>
  )
}

// ── TurboLLM Expert (spec 08 §2): launch an in-app expert chat ─────────────────

function ExpertSection() {
  const navigate = useNavigate()
  const { data: status } = useStatus()
  const mut = useConversationMutations()
  const setPendingConversationId = useUiStore((s) => s.setPendingConversationId)

  const modelLoaded = status?.engine.state === 'running' && !!status?.model

  const launch = () => {
    if (!modelLoaded) return
    mut.createExpert.mutate(undefined, {
      onSuccess: (conv) => {
        setPendingConversationId(conv.id)
        navigate('/chat')
      },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not launch the Expert assistant.'),
    })
  }

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">TurboLLM Expert</h2>
      <p className="mb-3 text-[12px] text-muted">
        Chat with a built-in assistant that knows TurboLLM — it can explain features, help
        configure engines, models, and settings, and troubleshoot. Runs on your loaded model.
      </p>

      {modelLoaded ? (
        <Button onClick={launch} disabled={mut.createExpert.isPending}>
          <Sparkles size={14} />
          {mut.createExpert.isPending ? 'Launching…' : 'Launch Expert'}
        </Button>
      ) : (
        <div
          className="flex items-start gap-2 rounded-md border p-2.5 text-[12px]"
          style={{
            borderColor: 'color-mix(in srgb, var(--accent) 40%, var(--border))',
            background: 'color-mix(in srgb, var(--accent) 6%, transparent)',
          }}
        >
          <Sparkles size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--accent)' }} />
          <div className="text-muted">
            Load a model first to chat with the Expert assistant. Pick one on the{' '}
            <button
              type="button"
              onClick={() => navigate('/models')}
              className="font-medium text-ink underline-offset-2 hover:underline"
            >
              Models
            </button>{' '}
            screen.
          </div>
        </div>
      )}
    </section>
  )
}

// ── Network (spec 08 §2): LAN expose toggle ───────────────────────────────────

function NetworkSection({ lanBind, setLanBind }: { lanBind: boolean; setLanBind: (v: boolean) => void }) {
  // hasApiKey + the reachable LAN URL come from the daemon (server-derived IP/port).
  const { data: net } = useNetworkInfo()
  const lanUrl = net?.lanUrl ?? ''
  const hasApiKey = net?.hasApiKey ?? false

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Network</h2>

      <label className="flex cursor-pointer items-center justify-between py-2">
        <div>
          <div className="text-[14px] font-medium text-ink">Expose on local network (LAN)</div>
          <div className="text-[12px] text-muted">Allow other devices on your network to reach the API</div>
        </div>
        <input
          type="checkbox"
          checked={lanBind}
          onChange={(e) => setLanBind(e.target.checked)}
          className="h-4 w-4 accent-[var(--accent)]"
        />
      </label>

      {lanBind && (
        <div className="mt-2 flex flex-col gap-2 border-t border-border pt-3">
          {lanUrl && (
            <div className="text-[13px]">
              <span className="text-muted">LAN URL: </span>
              <span className="font-mono text-ink">{lanUrl}</span>
            </div>
          )}
          <div
            className="flex items-start gap-2 rounded-md border p-2.5 text-[12px]"
            style={{
              borderColor: 'color-mix(in srgb, var(--warn) 40%, var(--border))',
              background: 'color-mix(in srgb, var(--warn) 8%, transparent)',
            }}
          >
            <ShieldAlert size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />
            <div className="text-muted">
              Anyone on your network can reach the API. An API key is required for non-local access.
              {!hasApiKey && (
                <>
                  {' '}
                  No API key exists yet — create one on the{' '}
                  <span className="font-medium text-ink">Developer</span> screen.
                </>
              )}
            </div>
          </div>
          <div className="text-[12px] text-faint">Restart the daemon to apply this change.</div>
        </div>
      )}
    </section>
  )
}

// ── Privacy & telemetry (spec 09 §5): opt-in consent, no transmission here ─────

function PrivacySection({ level, setLevel }: { level: TelemetryLevel; setLevel: (v: TelemetryLevel) => void }) {
  const [showPreview, setShowPreview] = useState(false)
  const { data: preview, isFetching } = useTelemetryPreview(showPreview ? level : null)

  const options: { value: TelemetryLevel; label: string; desc: string }[] = [
    { value: 'off', label: 'Off', desc: 'Send nothing. TurboLLM works fully offline.' },
    { value: 'anon', label: 'Anonymous benchmarks', desc: 'Hardware specs, model name, settings, and speed — no prompts or files.' },
    { value: 'full', label: 'Benchmarks + crash reports', desc: 'Adds error fingerprints, never your content.' },
  ]

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">Privacy &amp; telemetry</h2>
      <p className="mb-3 text-[12px] text-muted">
        Opt-in only. Nothing is sent unless you choose a level above Off. Never sent: your
        conversations, prompts, files, paths, or keys.
      </p>

      <div className="flex flex-col gap-1">
        {options.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-start gap-3 rounded-md px-1 py-2">
            <input
              type="radio"
              name="telemetry"
              checked={level === o.value}
              onChange={() => setLevel(o.value)}
              className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
            />
            <div>
              <div className="text-[14px] font-medium text-ink">{o.label}</div>
              <div className="text-[12px] text-muted">{o.desc}</div>
            </div>
          </label>
        ))}
      </div>

      <div className="mt-3 border-t border-border pt-3">
        <Button variant="outline" size="sm" onClick={() => setShowPreview((s) => !s)}>
          {showPreview ? 'Hide preview' : 'Preview what we send'}
        </Button>
        {showPreview && (
          <div className="mt-2">
            <p className="mb-1 text-[12px] text-faint">
              Illustrative example for “{options.find((o) => o.value === level)?.label}”. Nothing is
              transmitted from this screen.
            </p>
            <pre className="max-h-64 overflow-auto rounded-md border border-border bg-panel-2 p-2.5 font-mono text-[11px] text-muted">
              {isFetching
                ? 'Building preview…'
                : preview
                  ? JSON.stringify(preview.payload, null, 2)
                  : '—'}
            </pre>
          </div>
        )}
      </div>
    </section>
  )
}

// ── Hardware details (spec 08 §C) ─────────────────────────────────────────────

function HardwarePanel() {
  const { data: sys, isLoading } = useSysInfo()

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Hardware</h2>

      {isLoading || !sys ? (
        <p className="text-[13px] text-faint">Detecting hardware…</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5">
          {sys.gpus.length > 0 ? (
            sys.gpus.map((g, i) => (
              <StatRow
                key={i}
                label={sys.gpus.length > 1 ? `GPU ${i + 1}` : 'GPU'}
                value={`${g.name}${g.vramMb > 0 ? ` · ${(g.vramMb / 1000).toFixed(1)} GB VRAM` : ''}`}
              />
            ))
          ) : (
            <StatRow label="GPU" value="None detected (CPU-only)" />
          )}
          <StatRow label="CPU" value={`${sys.cpu || 'Unknown'} · ${sys.cores} cores`} />
          <StatRow label="RAM" value={`${(sys.ramMB / 1000).toFixed(1)} GB`} />
          <StatRow label="OS" value={sys.os} />
        </dl>
      )}
    </section>
  )
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="text-[13px] text-ink">{value}</dd>
    </>
  )
}

// ── Help ──────────────────────────────────────────────────────────────────────

function HelpSection() {
  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Help</h2>
      <div className="flex flex-col gap-2">
        <a
          href="https://github.com/bramha-dev/turbollm/issues/new"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-[13px] text-muted hover:text-ink transition-colors"
        >
          <ExternalLink size={13} />
          Report a bug
        </a>
        <a
          href="https://github.com/bramha-dev/turbollm/discussions"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-[13px] text-muted hover:text-ink transition-colors"
        >
          <ExternalLink size={13} />
          Send feedback
        </a>
      </div>
    </section>
  )
}
