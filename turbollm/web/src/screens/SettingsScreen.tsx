import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Moon, Sun, Monitor, Save, ExternalLink, ShieldAlert, Sparkles, RefreshCw, Check, X, Loader2 } from 'lucide-react'
import { ScreenHeader } from '../components/common'
import { Button } from '../components/ui/button'
import { useUiStore, type Theme } from '../stores/ui'
import {
  useDaemonRestart,
  useHfTokenTest,
  useNetworkInfo,
  useSettings,
  useStatus,
  useSysInfo,
  useTelemetryPreview,
} from '../lib/queries'
import { useConversationMutations } from '../lib/chat-queries'
import { ApiError, type TelemetryLevel } from '../lib/api'
import { toast } from '../components/ui/sonner'

/** localStorage key for the client-only "show thinking by default" preference
 *  (ADR-038). Default ON when unset. */
const SHOW_THINKING_KEY = 'tllm.showThinking.default'


export function SettingsScreen() {
  const { theme, setTheme } = useUiStore()
  const { query: settingsQ, save } = useSettings()
  const settings = settingsQ.data

  const [ttl, setTtl] = useState<number>(60)
  const [port, setPort] = useState<number>(6996)
  const [autoTitle, setAutoTitle] = useState(true)
  const [openBrowser, setOpenBrowser] = useState(true)
  const [autoLoad, setAutoLoad] = useState(false)
  const [defCtx, setDefCtx] = useState<number>(8192)
  const [defNgl, setDefNgl] = useState<number>(99)
  const [defImageMax, setDefImageMax] = useState<number>(0)
  const [telemetry, setTelemetry] = useState<TelemetryLevel>('off')
  const [lanBind, setLanBind] = useState(false)
  const [requireApiKey, setRequireApiKey] = useState(true)
  // Client-only "show thinking by default" preference (ADR-038); default ON.
  const [showThinking, setShowThinking] = useState(() => localStorage.getItem(SHOW_THINKING_KEY) !== 'false')

  // Full-screen overlay while the daemon re-execs (spec 08 §2).
  const [restartOverlay, setRestartOverlay] = useState(false)

  useEffect(() => {
    if (settings) {
      setTtl(settings.idleTtlMinutes)
      setPort(settings.port ?? 6996)
      setAutoTitle(settings.autoGenerateTitles)
      setOpenBrowser(settings.openBrowserOnStart)
      setAutoLoad(settings.autoLoadOnStart ?? false)
      setDefCtx(settings.modelDefaults?.ctx ?? 8192)
      setDefNgl(settings.modelDefaults?.ngl ?? 99)
      setDefImageMax(settings.modelDefaults?.imageMaxTokens ?? 0)
      setTelemetry(settings.telemetryLevel ?? 'off')
      setLanBind(settings.lanBind ?? false)
      setRequireApiKey(settings.requireApiKey ?? true)
    }
  }, [settings])

  // Persist the thinking preference immediately (no Save round-trip; it's client-only).
  useEffect(() => {
    localStorage.setItem(SHOW_THINKING_KEY, showThinking ? 'true' : 'false')
  }, [showThinking])

  const settingsPayload = () => ({
    idleTtlMinutes: ttl,
    port,
    autoGenerateTitles: autoTitle,
    openBrowserOnStart: openBrowser,
    autoLoadOnStart: autoLoad,
    telemetryLevel: telemetry,
    lanBind,
    requireApiKey,
    modelDefaults: { ctx: defCtx, ngl: defNgl, imageMaxTokens: defImageMax },
  })

  const handleSave = () => {
    save.mutate(settingsPayload(), {
      onSuccess: (res) => {
        const rb = res.rebind
        if (rb?.portChanged) {
          // The listener moved to a new port — hop the browser over once it's up.
          toast.success(`Port changed to ${rb.port} — reconnecting…`)
          setTimeout(() => {
            const u = new URL(window.location.href)
            u.port = String(rb.port)
            window.location.href = u.toString()
          }, 1300)
        } else if (rb) {
          // LAN-only change: applied in place, no restart, model stays loaded.
          toast.success(rb.lanBind ? 'LAN access enabled — applied (no restart needed)' : 'LAN access disabled — applied')
        } else {
          toast.success('Settings saved')
        }
      },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save settings.'),
    })
  }

  // Restart must persist pending changes FIRST — otherwise a port/LAN toggle the user
  // just flipped is lost and the re-exec'd daemon comes back on the old config.
  const requestRestart = () => {
    save.mutate(settingsPayload(), {
      onSuccess: () => setRestartOverlay(true),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save settings before restart.'),
    })
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-6">
      <ScreenHeader title="Settings" description="Configure TurboLLM behavior and appearance." />

      {restartOverlay && <RestartOverlay onDismiss={() => setRestartOverlay(false)} />}

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

          {/* Show thinking by default (ADR-038): client-only, default ON. */}
          <label className="mt-2 flex cursor-pointer items-center justify-between border-t border-border py-2 pt-3">
            <div>
              <div className="text-[14px] font-medium text-ink">Show thinking by default</div>
              <div className="text-[12px] text-muted">Expand a model's reasoning in new chats (you can still toggle it per message)</div>
            </div>
            <input
              type="checkbox"
              checked={showThinking}
              onChange={(e) => setShowThinking(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent)]"
            />
          </label>
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
        <NetworkSection lanBind={lanBind} setLanBind={setLanBind} requireApiKey={requireApiKey} setRequireApiKey={setRequireApiKey} port={port} setPort={setPort} />

        {/* Models — Hugging Face token (spec 10 §4) */}
        <HfTokenSection tokenSet={settings?.hfTokenSet ?? false} onSaved={() => void settingsQ.refetch()} />

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

        {/* Advanced (spec 08 §2): daemon restart */}
        <AdvancedSection onRestart={requestRestart} />

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

function NetworkSection({
  lanBind,
  setLanBind,
  requireApiKey,
  setRequireApiKey,
  port,
  setPort,
}: {
  lanBind: boolean
  setLanBind: (v: boolean) => void
  requireApiKey: boolean
  setRequireApiKey: (v: boolean) => void
  port: number
  setPort: (v: number) => void
}) {
  // hasApiKey + the reachable LAN URL come from the daemon (server-derived IP/port).
  const { data: net } = useNetworkInfo()
  const lanUrl = net?.lanUrl ?? ''
  const hasApiKey = net?.hasApiKey ?? false

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-3 text-[13px] font-semibold uppercase tracking-wide text-faint">Network</h2>

      <div className="flex items-center justify-between py-2">
        <div>
          <div className="text-[14px] font-medium text-ink">Port</div>
          <div className="text-[12px] text-muted">Port the daemon listens on (1024–65535)</div>
        </div>
        <input
          type="number"
          min={1024}
          max={65535}
          value={port}
          onChange={(e) => setPort(Math.max(1024, Math.min(65535, Number(e.target.value) || 1024)))}
          className="w-24 rounded-md border border-border bg-bg px-2 py-1 text-right text-[13px] text-ink outline-none"
        />
      </div>

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
        <div className="mt-2 flex flex-col gap-3 border-t border-border pt-3">
          {lanUrl && (
            <div className="text-[13px]">
              <span className="text-muted">LAN URL: </span>
              <span className="font-mono text-ink">{lanUrl}</span>
            </div>
          )}

          <label className="flex cursor-pointer items-center justify-between">
            <div>
              <div className="text-[14px] font-medium text-ink">Require an API key</div>
              <div className="text-[12px] text-muted">
                When off, any device on your network can use this TurboLLM with no key
              </div>
            </div>
            <input
              type="checkbox"
              checked={requireApiKey}
              onChange={(e) => setRequireApiKey(e.target.checked)}
              className="h-4 w-4 accent-[var(--accent)]"
            />
          </label>

          <div
            className="flex items-start gap-2 rounded-md border p-2.5 text-[12px]"
            style={{
              borderColor: 'color-mix(in srgb, var(--warn) 40%, var(--border))',
              background: 'color-mix(in srgb, var(--warn) 8%, transparent)',
            }}
          >
            <ShieldAlert size={14} className="mt-0.5 shrink-0" style={{ color: 'var(--warn)' }} />
            <div className="text-muted">
              {requireApiKey ? (
                <>
                  Other devices can reach the API, but a valid API key is required.
                  {!hasApiKey && (
                    <>
                      {' '}
                      No API key exists yet — create one on the{' '}
                      <span className="font-medium text-ink">Developer</span> screen.
                    </>
                  )}
                </>
              ) : (
                <>
                  <span className="font-medium text-ink">Open access:</span> any device on your
                  network can use this TurboLLM with no key. Only enable this on a network you trust.
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Port + LAN binding apply in place on Save — the listener re-binds without a
          full restart, so the model stays loaded (spec 08 §2). */}
      <div className="mt-2 border-t border-border pt-3 text-[12px] text-faint">
        Click <span className="font-medium text-ink">Save settings</span> to apply. The
        listener re-binds in place (no restart, model stays loaded); a port change
        reconnects this page automatically.
      </div>
    </section>
  )
}

// ── Models — Hugging Face token (spec 10 §4) ───────────────────────────────────

function HfTokenSection({ tokenSet, onSaved }: { tokenSet: boolean; onSaved: () => void }) {
  const { query: settingsQ, save } = useSettings()
  const test = useHfTokenTest()
  const [token, setToken] = useState('')
  // Tri-state test result: null = untested, then the daemon's {ok, name}.
  const [tested, setTested] = useState<{ ok: boolean; name?: string } | null>(null)

  // Reset the test result whenever the field changes (the prior result is stale).
  const onChange = (v: string) => {
    setToken(v)
    setTested(null)
  }

  const runTest = () => {
    if (!token.trim()) return
    test.mutate(token.trim(), {
      onSuccess: (r) => setTested(r),
      onError: () => setTested({ ok: false }),
    })
  }

  const handleSaveToken = () => {
    save.mutate(
      { hfToken: token.trim() },
      {
        onSuccess: () => {
          toast.success(token.trim() ? 'Hugging Face token saved' : 'Hugging Face token cleared')
          setToken('')
          setTested(null)
          onSaved()
        },
        onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the token.'),
      },
    )
  }

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">Models</h2>
      <p className="mb-3 text-[12px] text-muted">
        A Hugging Face access token lets you download gated models (e.g. Llama). Accept the
        model's license on huggingface.co, then paste a read token here.{' '}
        <a
          href="https://huggingface.co/settings/tokens"
          target="_blank"
          rel="noopener noreferrer"
          className="text-ink underline-offset-2 hover:underline"
        >
          Create a token
        </a>
        .
      </p>

      <div className="flex items-center justify-between py-1">
        <div className="text-[13px] text-muted">
          {tokenSet ? (
            <span className="inline-flex items-center gap-1.5 text-ink">
              <Check size={13} style={{ color: 'var(--ok)' }} />A token is configured
            </span>
          ) : (
            'No token configured'
          )}
        </div>
      </div>

      <div className="mt-1 flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type="password"
          value={token}
          onChange={(e) => onChange(e.target.value)}
          placeholder={tokenSet ? 'Enter a new token to replace the current one' : 'hf_…'}
          autoComplete="off"
          className="flex-1 rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[13px] text-ink outline-none"
        />
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={runTest} disabled={!token.trim() || test.isPending}>
            {test.isPending ? <Loader2 size={13} className="animate-spin" /> : 'Test'}
          </Button>
          <Button size="sm" onClick={handleSaveToken} disabled={save.isPending || settingsQ.isFetching}>
            {token.trim() ? 'Save token' : 'Clear token'}
          </Button>
        </div>
      </div>

      {tested && (
        <div className="mt-2 text-[12px]">
          {tested.ok ? (
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--ok)' }}>
              <Check size={13} />
              Valid{tested.name ? ` — signed in as ${tested.name}` : ''}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--err)' }}>
              <X size={13} />
              Invalid or unauthorized token
            </span>
          )}
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

// ── Advanced (spec 08 §2): daemon restart ─────────────────────────────────────

function AdvancedSection({ onRestart }: { onRestart: () => void }) {
  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">Advanced</h2>
      <p className="mb-3 text-[12px] text-muted">
        Restart the daemon to apply a new port or LAN binding without killing the terminal.
        Any loaded model is unloaded by a restart and must be reloaded afterward.
      </p>
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[14px] font-medium text-ink">Restart daemon</div>
          <div className="text-[12px] text-muted">Stops the engine, then re-launches the daemon process</div>
        </div>
        <Button variant="outline" size="sm" onClick={onRestart}>
          <RefreshCw size={13} />
          Restart daemon
        </Button>
      </div>
    </section>
  )
}

// ── Restart overlay (spec 08 §2): fires the restart, then polls /status until the
// new daemon answers and reloads the page. Tolerates the down window (fetch throws
// → keep polling). Uses a raw fetch (not the query cache) since the socket drops. ──

function RestartOverlay({ onDismiss }: { onDismiss: () => void }) {
  const restart = useDaemonRestart()
  const [phase, setPhase] = useState<'restarting' | 'failed'>('restarting')
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    let cancelled = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    let giveUpTimer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      if (cancelled) return
      try {
        const res = await fetch('/api/v1/status', { headers: { Accept: 'application/json' } })
        if (res.ok) {
          // Daemon is back — full reload so the SPA reconnects on the (possibly new) port.
          if (!cancelled) window.location.reload()
          return
        }
      } catch {
        // Daemon still down (socket refused) — expected mid-restart; keep polling.
      }
      if (!cancelled) pollTimer = setTimeout(poll, 700)
    }

    restart.mutate(undefined, {
      onSuccess: () => {
        // Give the old process a beat to release the socket, then poll for the new one.
        pollTimer = setTimeout(poll, 700)
        // If it hasn't come back in 20s, surface a manual fallback.
        giveUpTimer = setTimeout(() => {
          if (!cancelled) setPhase('failed')
        }, 20_000)
      },
      onError: (e) => {
        if (!cancelled) {
          setPhase('failed')
          toast.error(e instanceof ApiError ? e.message : 'Could not restart the daemon.')
        }
      },
    })

    return () => {
      cancelled = true
      if (pollTimer) clearTimeout(pollTimer)
      if (giveUpTimer) clearTimeout(giveUpTimer)
    }
    // Intentionally run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/90 backdrop-blur-sm">
      <div className="flex max-w-sm flex-col items-center gap-3 rounded-lg border border-border bg-panel p-6 text-center">
        {phase === 'restarting' ? (
          <>
            <Loader2 size={28} className="animate-spin" style={{ color: 'var(--accent)' }} />
            <div className="text-[15px] font-medium text-ink">Restarting daemon…</div>
            <div className="text-[12px] text-muted">
              Applying your changes. The page will reload automatically when the daemon is back.
            </div>
          </>
        ) : (
          <>
            <ShieldAlert size={28} style={{ color: 'var(--warn)' }} />
            <div className="text-[15px] font-medium text-ink">Daemon is taking a while</div>
            <div className="text-[12px] text-muted">
              It may have moved to a new port. Try reloading, or check the terminal where you
              started TurboLLM.
            </div>
            <div className="mt-1 flex gap-2">
              <Button variant="outline" size="sm" onClick={onDismiss}>
                Dismiss
              </Button>
              <Button size="sm" onClick={() => window.location.reload()}>
                Reload now
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
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
