import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Bot, CircleDot, CheckCircle2, XCircle, Clock, Loader2, Plus, X, Wrench } from 'lucide-react'
import { cn } from '../lib/utils'
import { agentRunKeys, fetchAgentRuns, fetchAgentRun, createAgentRun, cancelAgentRun, subscribeRunStream } from '../lib/agent-api'
import type { AgentRun, AgentRunStatus } from '../lib/agent-types'

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_ICON: Record<AgentRunStatus, React.ReactNode> = {
  queued:      <Clock size={12} />,
  running:     <Loader2 size={12} className="animate-spin" />,
  done:        <CheckCircle2 size={12} />,
  failed:      <XCircle size={12} />,
  cancelled:   <XCircle size={12} />,
  interrupted: <XCircle size={12} />,
}
const STATUS_COLOR: Record<AgentRunStatus, string> = {
  queued:      'text-muted',
  running:     'text-accent',
  done:        'text-green-500',
  failed:      'text-red-500',
  cancelled:   'text-muted',
  interrupted: 'text-orange-500',
}

function StatusBadge({ status }: { status: AgentRunStatus }) {
  return (
    <span className={cn('flex items-center gap-1 text-[11px] capitalize', STATUS_COLOR[status])}>
      {STATUS_ICON[status]}{status}
    </span>
  )
}

// ── Time formatter ────────────────────────────────────────────────────────────

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return new Date(iso).toLocaleDateString()
}

// ── New Run Dialog ────────────────────────────────────────────────────────────

const TOOL_OPTIONS = [
  { id: 'web_search', label: 'Web search', hint: 'Search the web (needs a provider configured in Settings)' },
  { id: 'fetch_url', label: 'Fetch URL', hint: 'Read the contents of a web page' },
  { id: 'run_code', label: 'Run code', hint: 'Execute JS in a sandbox — no mid-run confirmation, opt in only if you trust the task' },
] as const

function NewRunDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [task, setTask] = useState('')
  const [systemPrompt, setSystemPrompt] = useState('')
  // Research is the primary use case → web_search + fetch_url on by default; run_code off (§3.6).
  const [tools, setTools] = useState<Record<string, boolean>>({ web_search: true, fetch_url: true, run_code: false })
  const qc = useQueryClient()

  const toggleTool = (id: string) => setTools((t) => ({ ...t, [id]: !t[id] }))

  const create = useMutation({
    mutationFn: () =>
      createAgentRun({
        title: task.slice(0, 60) || 'Agent run',
        systemPrompt: systemPrompt || undefined,
        userMessage: task,
        allowedTools: Object.entries(tools).filter(([, on]) => on).map(([id]) => id),
      }),
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: agentRunKeys.list() })
      onCreated(run.id)
      onClose()
    },
  })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-border bg-panel p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold">New agent run</h2>
          <button type="button" onClick={onClose} className="text-faint hover:text-ink"><X size={16} /></button>
        </div>

        <label className="mb-1 block text-[12px] text-muted">Task</label>
        <textarea
          autoFocus
          value={task}
          onChange={(e) => setTask(e.target.value)}
          placeholder="Describe what the agent should do…"
          rows={4}
          className="mb-3 w-full resize-none rounded-lg border border-border bg-input px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
        />

        <label className="mb-1 block text-[12px] text-muted">System prompt <span className="text-faint">(optional)</span></label>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="You are a helpful assistant…"
          rows={2}
          className="mb-4 w-full resize-none rounded-lg border border-border bg-input px-3 py-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
        />

        <label className="mb-1.5 block text-[12px] text-muted">Tools</label>
        <div className="mb-4 space-y-1.5">
          {TOOL_OPTIONS.map((t) => (
            <label
              key={t.id}
              className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-2.5 py-2 hover:bg-panel-2"
            >
              <input
                type="checkbox"
                checked={tools[t.id]}
                onChange={() => toggleTool(t.id)}
                className="mt-0.5 accent-[var(--accent)]"
              />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-ink">{t.label}</span>
                <span className="block text-[11px] leading-snug text-faint">{t.hint}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-[13px] text-muted hover:text-ink">Cancel</button>
          <button
            type="button"
            disabled={!task.trim() || create.isPending}
            onClick={() => create.mutate()}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-50"
          >
            {create.isPending ? <Loader2 size={13} className="animate-spin" /> : <Bot size={13} />}
            Run agent
          </button>
        </div>
        {create.isError && (
          <p className="mt-2 text-[12px]" style={{ color: 'var(--err)' }}>
            {(create.error as Error).message}
          </p>
        )}
      </div>
    </div>
  )
}

// ── Tool-call step (collapsible) ──────────────────────────────────────────────

function ToolCallRow({ call }: { call: import('../lib/agent-types').AgentToolCall }) {
  const [open, setOpen] = useState(false)
  const summary =
    typeof call.args?.query === 'string' ? call.args.query
    : typeof call.args?.url === 'string' ? call.args.url
    : JSON.stringify(call.args ?? {})
  return (
    <div className="w-full max-w-[85%] rounded-lg border border-border bg-panel px-2.5 py-1.5 text-[12px]">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 text-left text-muted hover:text-ink">
        <Wrench size={12} className="shrink-0 text-accent" />
        <span className="font-medium text-ink">{call.name}</span>
        <span className="truncate text-faint">{summary}</span>
      </button>
      {open && (
        <pre className="mt-1.5 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-panel-2 p-2 text-[11px] text-muted">
          {call.result}
        </pre>
      )}
    </div>
  )
}

// ── Run messages view ─────────────────────────────────────────────────────────

function RunDetail({ run }: { run: AgentRun }) {
  const qc = useQueryClient()
  const abortRef = useRef<AbortController | null>(null)
  const [liveContent, setLiveContent] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const cancel = useMutation({
    mutationFn: () => cancelAgentRun(run.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: agentRunKeys.list() }),
  })

  // Stream live events when the run is active
  useEffect(() => {
    if (run.status !== 'running' && run.status !== 'queued') return
    const ac = new AbortController()
    abortRef.current = ac
    let content = ''

    void (async () => {
      try {
        for await (const ev of subscribeRunStream(run.id, 0, ac.signal)) {
          if (ev.event === 'delta') {
            content += (ev.data as { delta: string }).delta
            setLiveContent(content)
          } else if (ev.event === 'done' || ev.event === 'error') {
            void qc.invalidateQueries({ queryKey: agentRunKeys.detail(run.id) })
            void qc.invalidateQueries({ queryKey: agentRunKeys.list() })
            break
          }
        }
      } catch { /* aborted or connection closed */ }
    })()

    return () => { ac.abort(); abortRef.current = null }
  }, [run.id, run.status, qc])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [liveContent, run.messages?.length])

  const messages = run.messages ?? []

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div>
          <p className="text-[14px] font-medium text-ink">{run.title}</p>
          <StatusBadge status={run.status} />
        </div>
        {(run.status === 'running' || run.status === 'queued') && (
          <button
            type="button"
            onClick={() => cancel.mutate()}
            className="rounded-lg border border-border px-3 py-1 text-[12px] text-muted transition-colors hover:border-red-400 hover:text-red-500"
          >
            {cancel.isPending ? <Loader2 size={12} className="inline animate-spin" /> : 'Cancel'}
          </button>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((msg) => (
          <div key={msg.id} className={cn('flex flex-col gap-1.5', msg.role === 'user' ? 'items-end' : 'items-start')}>
            {/* Tool calls (research steps) shown above the assistant's answer */}
            {msg.toolCalls?.map((tc) => (
              <ToolCallRow key={tc.id} call={tc} />
            ))}
            {(msg.content || msg.role === 'user' || run.status === 'running') && (
              <div
                className={cn(
                  'max-w-[85%] rounded-xl px-3 py-2 text-[13px] leading-relaxed',
                  msg.role === 'user' ? 'bg-accent/15 text-ink' : 'bg-panel-2 text-ink',
                )}
              >
                <p className="whitespace-pre-wrap break-words">
                  {msg.content || (msg.role === 'assistant' && run.status === 'running' ? '…' : '')}
                </p>
              </div>
            )}
          </div>
        ))}
        {/* Live streaming output (replaces empty placeholder) */}
        {liveContent && (
          <div className="flex gap-2">
            <div className="max-w-[85%] rounded-xl bg-panel-2 px-3 py-2 text-[13px] leading-relaxed text-ink">
              <p className="whitespace-pre-wrap break-words">{liveContent}</p>
            </div>
          </div>
        )}
        {run.error && (
          <div className="rounded-lg bg-red-500/10 px-3 py-2 text-[12px] text-red-500">
            Error: {run.error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

// ── Main screen ───────────────────────────────────────────────────────────────

export function AgentsScreen() {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showDialog, setShowDialog] = useState(false)

  const runsQ = useQuery({
    queryKey: agentRunKeys.list(),
    queryFn: fetchAgentRuns,
    refetchInterval: (q) => {
      const runs = q.state.data ?? []
      const hasActive = runs.some((r) => r.status === 'queued' || r.status === 'running')
      return hasActive ? 3000 : false
    },
  })

  const detailQ = useQuery({
    queryKey: agentRunKeys.detail(selectedId ?? ''),
    queryFn: () => fetchAgentRun(selectedId!),
    enabled: !!selectedId,
    refetchInterval: (q) => {
      const run = q.state.data
      const active = run?.status === 'queued' || run?.status === 'running'
      return active ? 5000 : false
    },
  })

  const runs = runsQ.data ?? []
  const selected = detailQ.data

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="flex w-64 shrink-0 flex-col border-r border-border">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <span className="text-[13px] font-semibold text-ink">Agents</span>
          <button
            type="button"
            title="New agent run"
            onClick={() => setShowDialog(true)}
            className="flex items-center gap-1 rounded-lg bg-accent px-2 py-1 text-[11px] font-medium text-white transition-opacity hover:opacity-90"
          >
            <Plus size={11} /> New
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {runsQ.isLoading && (
            <div className="flex h-20 items-center justify-center">
              <Loader2 size={16} className="animate-spin text-faint" />
            </div>
          )}
          {runs.length === 0 && !runsQ.isLoading && (
            <div className="px-4 py-8 text-center">
              <Bot size={28} className="mx-auto mb-2 text-faint" />
              <p className="text-[12px] text-muted">No agent runs yet.</p>
              <p className="mt-0.5 text-[11px] text-faint">Click &ldquo;New&rdquo; to start one.</p>
            </div>
          )}
          {runs.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => setSelectedId(run.id)}
              className={cn(
                'w-full border-b border-border px-3 py-2.5 text-left transition-colors hover:bg-panel-2',
                selectedId === run.id && 'bg-panel-2',
              )}
            >
              <p className="mb-0.5 truncate text-[13px] font-medium text-ink">{run.title}</p>
              <div className="flex items-center justify-between">
                <StatusBadge status={run.status} />
                <span className="text-[10px] text-faint">{relTime(run.createdAt)}</span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Detail pane */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!selectedId ? (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <CircleDot size={32} className="mb-3 text-faint" />
            <p className="text-[14px] font-medium text-ink">Select a run</p>
            <p className="mt-1 text-[12px] text-muted">or create a new agent run to get started</p>
            <button
              type="button"
              onClick={() => setShowDialog(true)}
              className="mt-4 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-[13px] font-medium text-white hover:opacity-90"
            >
              <Plus size={13} /> New agent run
            </button>
          </div>
        ) : detailQ.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 size={20} className="animate-spin text-faint" />
          </div>
        ) : selected ? (
          <RunDetail run={selected} />
        ) : null}
      </div>

      {showDialog && (
        <NewRunDialog
          onClose={() => setShowDialog(false)}
          onCreated={(id) => {
            setSelectedId(id)
            void runsQ.refetch()
          }}
        />
      )}
    </div>
  )
}
