import { useState } from 'react'
import { Check, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { ScreenHeader } from '../components/common'
import { Button } from '../components/ui/button'
import { toast } from '../components/ui/sonner'
import { useMcpMutations, useSettings } from '../lib/queries'
import { ApiError } from '../lib/api'
import type { McpServer, DaemonSettings, DaemonSettingsPatch, SearchProvider } from '../lib/api'

export function CustomizeScreen() {
  const { query: settingsQ } = useSettings()
  const settings = settingsQ.data

  return (
    <div className="w-full px-6 py-6">
      <ScreenHeader
        title="Customize"
        description="Add tools and external providers the model can call during conversations."
      />
      <div className="flex flex-col gap-6">
        <ToolsSection
          search={settings?.search ?? { provider: 'tavily', tavilyKeySet: false, kagiKeySet: false, searxngUrl: '' }}
          onSaved={() => void settingsQ.refetch()}
        />
        <McpSection servers={settings?.mcp?.servers ?? []} />
      </div>
    </div>
  )
}

// ── Tools — web search provider (Tavily / Kagi / SearXNG, F-020) ─────────────

type ProviderMeta = { id: SearchProvider; label: string; blurb: string; getKey?: string }
const PROVIDERS: ProviderMeta[] = [
  { id: 'tavily', label: 'Tavily', blurb: 'AI-search API tuned for LLMs. Reliable default.', getKey: 'https://app.tavily.com' },
  { id: 'kagi', label: 'Kagi', blurb: 'Premium search, no bot-blocking, no tracking ($0.012/query).', getKey: 'https://kagi.com/settings?p=api' },
  { id: 'searxng', label: 'SearXNG', blurb: 'Your own self-hosted meta-search. Fully local — no key, just a URL.' },
]

function ToolsSection({ search, onSaved }: { search: DaemonSettings['search']; onSaved: () => void }) {
  const { save } = useSettings()
  const [provider, setProvider] = useState<SearchProvider>(search.provider)
  const [secret, setSecret] = useState('') // key (tavily/kagi) or URL (searxng)

  const meta = PROVIDERS.find((p) => p.id === provider)!
  const isUrl = provider === 'searxng'
  const configured = provider === 'tavily' ? search.tavilyKeySet : provider === 'kagi' ? search.kagiKeySet : !!search.searxngUrl

  // Switching the segmented control resets the input and pre-fills the SearXNG URL.
  const pick = (p: SearchProvider) => {
    setProvider(p)
    setSecret(p === 'searxng' ? search.searxngUrl : '')
  }

  const handleSave = () => {
    const v = secret.trim()
    const patch: DaemonSettingsPatch['search'] = { provider }
    // Secrets: only send when the user typed something (avoid wiping a stored key on a bare
    // provider switch). The SearXNG URL is visible/echoed, so an empty box genuinely clears it.
    if (isUrl) patch.searxngUrl = v
    else if (v && provider === 'tavily') patch.tavilyApiKey = v
    else if (v && provider === 'kagi') patch.kagiApiKey = v
    save.mutate({ search: patch }, {
      onSuccess: () => {
        toast.success(`Search set to ${meta.label}${v ? ` — ${isUrl ? 'URL' : 'key'} saved` : ''}`)
        if (!isUrl) setSecret('')
        onSaved()
      },
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save search settings.'),
    })
  }

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">Web Search</h2>
      <p className="mb-3 text-[12px] text-muted">
        Choose a search provider. When one is configured, the model can call the{' '}
        <span className="font-mono text-ink">web_search</span> tool automatically.
      </p>

      <div className="mb-3 inline-flex rounded-md border border-border p-0.5">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            onClick={() => pick(p.id)}
            className={`rounded px-3 py-1 text-[13px] transition-colors ${
              provider === p.id ? 'bg-bg text-ink' : 'text-muted hover:text-ink'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <p className="mb-2 text-[12px] text-muted">
        {meta.blurb}{' '}
        {meta.getKey && (
          <a href={meta.getKey} target="_blank" rel="noopener noreferrer" className="text-ink underline-offset-2 hover:underline">
            Get a key
          </a>
        )}
      </p>

      <div className="mb-2 text-[13px] text-muted">
        {configured ? (
          <span className="inline-flex items-center gap-1.5 text-ink">
            <Check size={13} style={{ color: 'var(--ok)' }} /> {isUrl ? 'A URL is configured' : 'A key is configured'}
          </span>
        ) : isUrl ? 'No URL configured' : 'No key configured'}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          type={isUrl ? 'text' : 'password'}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={isUrl ? 'http://localhost:8888' : configured ? 'Enter a new key to replace the current one' : provider === 'tavily' ? 'tvly-…' : 'Kagi API key'}
          autoComplete="off"
          className="flex-1 rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[13px] text-ink outline-none"
        />
        <Button size="sm" onClick={handleSave} disabled={save.isPending}>
          Save
        </Button>
      </div>

      <p className="mt-3 text-[12px] text-faint">
        <span className="font-mono text-ink">fetch_url</span> and{' '}
        <span className="font-mono text-ink">run_code</span> (sandboxed JS) are always available — no key needed.
      </p>
    </section>
  )
}

// ── MCP Servers ───────────────────────────────────────────────────────────────

type McpFormState = {
  name: string
  transport: 'stdio' | 'sse'
  command: string
  argsStr: string
  envStr: string
  url: string
  enabled: boolean
}

const emptyMcpForm = (): McpFormState => ({
  name: '', transport: 'stdio', command: '', argsStr: '', envStr: '', url: '', enabled: true,
})

function serverToForm(s: McpServer): McpFormState {
  return {
    name: s.name,
    transport: s.transport,
    command: s.command ?? '',
    argsStr: (s.args ?? []).join(', '),
    envStr: Object.entries(s.env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'),
    url: s.url ?? '',
    enabled: s.enabled,
  }
}

function formToPayload(f: McpFormState): Omit<McpServer, 'id'> {
  const args = f.argsStr.trim() ? f.argsStr.split(',').map((s) => s.trim()).filter(Boolean) : []
  const env: Record<string, string> = {}
  for (const line of f.envStr.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return {
    name: f.name.trim(),
    transport: f.transport,
    command: f.transport === 'stdio' ? f.command.trim() || undefined : undefined,
    args: f.transport === 'stdio' && args.length ? args : undefined,
    env: f.transport === 'stdio' && Object.keys(env).length ? env : undefined,
    url: f.transport === 'sse' ? f.url.trim() || undefined : undefined,
    enabled: f.enabled,
  }
}

function McpSection({ servers }: { servers: McpServer[] }) {
  const mut = useMcpMutations()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<McpFormState>(emptyMcpForm())
  const set = (patch: Partial<McpFormState>) => setForm((p) => ({ ...p, ...patch }))

  const openAdd = () => { setEditingId(null); setForm(emptyMcpForm()); setShowForm(true) }
  const openEdit = (s: McpServer) => { setEditingId(s.id); setForm(serverToForm(s)); setShowForm(true) }
  const closeForm = () => { setShowForm(false); setEditingId(null) }

  const handleSubmit = () => {
    const payload = formToPayload(form)
    if (!payload.name) return void toast.error('Server name is required.')
    if (payload.transport === 'stdio' && !payload.command) return void toast.error('Command is required for stdio transport.')
    if (payload.transport === 'sse' && !payload.url) return void toast.error('URL is required for SSE transport.')
    const opts = {
      onSuccess: () => { toast.success(editingId ? 'MCP server updated' : 'MCP server added'); closeForm() },
      onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Could not save server.'),
    }
    if (editingId) mut.update.mutate({ id: editingId, patch: payload }, opts)
    else mut.add.mutate(payload, opts)
  }

  const handleDelete = (id: string, name: string) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Remove MCP server "${name}"?`)) return
    mut.remove.mutate(id, { onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not remove server.') })
  }

  const handleToggle = (s: McpServer) => {
    mut.update.mutate({ id: s.id, patch: { enabled: !s.enabled } }, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update server.'),
    })
  }

  const f = form
  const busy = mut.add.isPending || mut.update.isPending

  return (
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="mb-1 text-[13px] font-semibold uppercase tracking-wide text-faint">MCP Servers</h2>
      <p className="mb-3 text-[12px] text-muted">
        Connect external tool providers via the Model Context Protocol. Supports stdio (subprocess)
        and SSE (HTTP) transports per the MCP 2024-11-05 spec.
      </p>

      {servers.length > 0 && (
        <div className="mb-3 flex flex-col gap-1.5">
          {servers.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-lg border border-border bg-panel-2 px-3 py-2">
              <span
                className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-medium"
                style={{
                  background: s.transport === 'sse'
                    ? 'color-mix(in srgb, var(--accent) 15%, transparent)'
                    : 'color-mix(in srgb, var(--muted) 20%, transparent)',
                  color: s.transport === 'sse' ? 'var(--accent)' : 'var(--muted)',
                }}
              >
                {s.transport}
              </span>
              <span className="flex-1 truncate text-[13px] font-medium text-ink">{s.name}</span>
              <span
                className="hidden shrink-0 max-w-[220px] truncate font-mono text-[11px] text-faint sm:block"
                title={s.transport === 'stdio' ? s.command : s.url}
              >
                {s.transport === 'stdio' ? s.command?.split(/[\\/]/).slice(-1)[0] : s.url}
              </span>
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={() => handleToggle(s)}
                title={s.enabled ? 'Disable' : 'Enable'}
                className="h-3.5 w-3.5 accent-[var(--accent)]"
              />
              <button
                type="button"
                onClick={() => openEdit(s)}
                title="Edit"
                className="rounded p-1 text-faint transition-colors hover:bg-bg hover:text-ink"
              >
                <Pencil size={12} />
              </button>
              <button
                type="button"
                onClick={() => handleDelete(s.id, s.name)}
                title="Delete"
                className="rounded p-1 transition-colors hover:bg-bg"
                style={{ color: 'var(--err)' }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {!showForm ? (
        <Button variant="outline" size="sm" onClick={openAdd}>
          <Plus size={13} />
          Add server
        </Button>
      ) : (
        <div className="flex flex-col gap-3 rounded-lg border border-border bg-panel-2 p-3">
          <div className="text-[13px] font-medium text-ink">{editingId ? 'Edit server' : 'Add server'}</div>

          <div className="flex flex-col gap-1">
            <label className="text-[12px] text-muted">Name</label>
            <input
              type="text"
              value={f.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="My Tool Server"
              className="rounded-md border border-border bg-bg px-2 py-1.5 text-[13px] text-ink outline-none"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[12px] text-muted">Transport</label>
            <div className="flex gap-4">
              {(['stdio', 'sse'] as const).map((t) => (
                <label key={t} className="flex cursor-pointer items-center gap-1.5 text-[13px] text-ink">
                  <input
                    type="radio"
                    name="mcp-transport"
                    checked={f.transport === t}
                    onChange={() => set({ transport: t })}
                    className="h-3.5 w-3.5 accent-[var(--accent)]"
                  />
                  <span className="font-mono">{t}</span>
                  <span className="text-[11px] text-faint">{t === 'stdio' ? '(subprocess)' : '(HTTP)'}</span>
                </label>
              ))}
            </div>
          </div>

          {f.transport === 'stdio' ? (
            <>
              <div className="flex flex-col gap-1">
                <label className="text-[12px] text-muted">Command</label>
                <input
                  type="text"
                  value={f.command}
                  onChange={(e) => set({ command: e.target.value })}
                  placeholder="npx -y @modelcontextprotocol/server-filesystem"
                  className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[12px] text-muted">
                  Args <span className="text-faint">(comma-separated, optional)</span>
                </label>
                <input
                  type="text"
                  value={f.argsStr}
                  onChange={(e) => set({ argsStr: e.target.value })}
                  placeholder="--port, 3000"
                  className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[12px] text-muted">
                  Env vars <span className="text-faint">(KEY=VALUE, one per line, optional)</span>
                </label>
                <textarea
                  rows={2}
                  value={f.envStr}
                  onChange={(e) => set({ envStr: e.target.value })}
                  placeholder={"API_KEY=abc123\nDEBUG=true"}
                  className="resize-none rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none"
                />
              </div>
            </>
          ) : (
            <div className="flex flex-col gap-1">
              <label className="text-[12px] text-muted">URL</label>
              <input
                type="text"
                value={f.url}
                onChange={(e) => set({ url: e.target.value })}
                placeholder="http://localhost:3000"
                className="rounded-md border border-border bg-bg px-2 py-1.5 font-mono text-[12px] text-ink outline-none"
              />
            </div>
          )}

          <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={f.enabled}
              onChange={(e) => set({ enabled: e.target.checked })}
              className="h-3.5 w-3.5 accent-[var(--accent)]"
            />
            Enable immediately
          </label>

          <div className="flex gap-2">
            <Button size="sm" onClick={handleSubmit} disabled={busy}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : null}
              {editingId ? 'Update' : 'Add'}
            </Button>
            <Button variant="outline" size="sm" onClick={closeForm}>Cancel</Button>
          </div>
        </div>
      )}
    </section>
  )
}
