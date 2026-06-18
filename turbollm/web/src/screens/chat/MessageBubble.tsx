import { memo, useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { CheckCircle2, ChevronDown, FileText, Loader2, Pencil, RefreshCw, Trash2, XCircle } from 'lucide-react'
import type { LiveToolCall, Message, MessageStats, ToolCallRecord } from '../../lib/chat-types'
import { Button } from '../../components/ui/button'
import { CopyButton } from '../../components/ui/copy-button'

// ── Thinking block ────────────────────────────────────────────────────────────

function ThinkingBlock({ reasoning, thinkMs, streaming, showThinking = true }: { reasoning: string; thinkMs?: number; streaming?: boolean; showThinking?: boolean }) {
  // Always collapsed by default; expands into a fixed-height scroll window so long
  // reasoning never balloons the chat.
  const [open, setOpen] = useState(false)
  const scrollRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (open && streaming && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [reasoning, open, streaming])
  const label = thinkMs ? `Thought for ${(thinkMs / 1000).toFixed(1)}s` : streaming ? 'Thinking…' : 'Thinking'
  // When thinking is globally hidden, show only the stats line (no expand toggle).
  if (!showThinking) {
    return (
      <div className="mb-3 text-[12px] font-medium text-faint px-0 py-0.5">
        {label}
      </div>
    )
  }
  return (
    <div className="mb-3 rounded-lg border border-border bg-panel-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-3 py-2 text-[12px] font-medium text-muted hover:text-ink"
      >
        <ChevronDown size={13} className={open ? 'rotate-180 transition-transform' : 'transition-transform'} />
        {label}
        {streaming && !open && <span className="tllm-pulse ml-0.5">·</span>}
      </button>
      {open && (
        <pre
          ref={scrollRef}
          className="max-h-48 overflow-auto px-3 pb-3 font-mono text-[12px] leading-relaxed text-muted whitespace-pre-wrap"
        >
          {reasoning}
        </pre>
      )}
    </div>
  )
}

// ── Stats row ─────────────────────────────────────────────────────────────────

function StatsRow({ stats }: { stats: Partial<MessageStats> }) {
  const parts: string[] = []
  if (stats.tps)          parts.push(`${stats.tps.toFixed(1)} tok/s`)
  if (stats.promptTps)    parts.push(`${stats.promptTps.toFixed(0)} tok/s prefill`)
  if (stats.ttftMs != null && stats.ttftMs > 0) parts.push(`${(stats.ttftMs / 1000).toFixed(2)}s TTFT`)
  if (stats.promptTokens != null && stats.genTokens != null) parts.push(`${stats.promptTokens}+${stats.genTokens} tokens`)
  if (stats.cachedTokens != null && stats.cachedTokens > 0) {
    const pct = stats.promptTokens ? Math.round((stats.cachedTokens / stats.promptTokens) * 100) : 0
    parts.push(`${stats.cachedTokens} cached${pct ? ` (${pct}%)` : ''}`)
  }
  if (stats.totalMs)      parts.push(`${(stats.totalMs / 1000).toFixed(1)}s total`)

  if (!parts.length) return null

  const tooltip = [
    stats.model       ? `Model: ${stats.model}` : '',
    stats.promptMs    ? `Prefill: ${stats.promptMs.toFixed(0)}ms` : '',
    stats.genMs       ? `Gen: ${stats.genMs.toFixed(0)}ms` : '',
    stats.ctxUsed != null ? `Context: ${stats.ctxUsed} / ${stats.ctxMax}` : '',
    stats.aborted     ? 'Aborted' : '',
  ].filter(Boolean).join('\n')

  return (
    <div className="mt-2 text-[11px] text-faint" title={tooltip}>
      {parts.join(' · ')}
      {stats.aborted && <span className="ml-2" style={{ color: 'var(--warn)' }}>· aborted</span>}
    </div>
  )
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">{children}</a>
        ),
        code: ({ className, children, ...props }) => {
          // A fenced block without a language tag has no className — detect it by
          // checking for a trailing newline, which react-markdown always appends to
          // block code. Inline code never contains newlines in practice.
          const hasLang = !!className?.includes('language-')
          const isBlock = hasLang || (typeof children === 'string' && children.includes('\n'))
          if (!isBlock) return <code className="rounded bg-panel-2 px-1 py-0.5 font-mono text-[0.88em]" {...props}>{children}</code>
          const lang = className?.replace('language-', '') ?? ''
          return (
            <div className="relative my-2 overflow-hidden rounded-lg border border-border">
              <div className="flex items-center justify-between border-b border-border bg-panel-2 px-3 py-1 font-mono text-[11px] text-muted">
                <span>{lang}</span>
                <CopyButton text={String(children)} size={12} />
              </div>
              <div className="overflow-x-auto overscroll-x-contain" onScroll={e => e.stopPropagation()}>
                <code className={`${className ?? ''} block p-3 font-mono text-[13px] leading-relaxed whitespace-pre`} {...props}>{children}</code>
              </div>
            </div>
          )
        },
        pre: ({ children }) => <>{children}</>,
        table: ({ children }) => <div className="overflow-x-auto my-2"><table className="w-full border-collapse text-[13px]">{children}</table></div>,
        th: ({ children }) => <th className="border border-border bg-panel-2 px-3 py-1.5 text-left font-semibold text-[13px]">{children}</th>,
        td: ({ children }) => <td className="border border-border px-3 py-1.5 text-[13px]">{children}</td>,
      }}
    >
      {children}
    </ReactMarkdown>
  )
})

// ── Tool call cards ───────────────────────────────────────────────────────────

type CardCall = { id: string; name: string; status: 'pending' | 'done' | 'error'; result?: string }

function friendlyName(name: string): string {
  if (name.startsWith('mcp__')) return name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')
  return name.replace(/_/g, ' ')
}

function ToolCallCard({ call }: { call: CardCall }) {
  const [expanded, setExpanded] = useState(false)
  const hasOutput = !!(call.result?.length)

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-panel-2">
      <button
        type="button"
        onClick={() => hasOutput && setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
        style={{ cursor: hasOutput ? 'pointer' : 'default' }}
      >
        {call.status === 'pending' && <Loader2 size={12} className="shrink-0 animate-spin" style={{ color: 'var(--accent)' }} />}
        {call.status === 'done'    && <CheckCircle2 size={12} className="shrink-0" style={{ color: '#4ade80' }} />}
        {call.status === 'error'   && <XCircle size={12} className="shrink-0" style={{ color: 'var(--err)' }} />}
        <span className="font-mono text-[12px] font-medium text-ink">{friendlyName(call.name)}</span>
        <span className="text-[11px] text-faint">
          {call.status === 'pending' ? 'running…' : call.status === 'error' ? 'error' : 'done'}
        </span>
        {hasOutput && (
          <ChevronDown
            size={11}
            className={`ml-auto shrink-0 text-faint transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
        )}
      </button>
      {expanded && call.result && (
        <pre className="max-h-48 overflow-auto border-t border-border px-3 pb-3 pt-2 font-mono text-[11px] leading-relaxed text-muted whitespace-pre-wrap">
          {call.result.length > 2000 ? `${call.result.slice(0, 2000)}\n…(truncated)` : call.result}
        </pre>
      )}
    </div>
  )
}

function ToolCallsPanel({ calls }: { calls: CardCall[] }) {
  if (!calls.length) return null
  return (
    <div className="mb-3 space-y-1">
      {calls.map((c) => <ToolCallCard key={c.id} call={c} />)}
    </div>
  )
}

// ── Streaming message (in-progress) ──────────────────────────────────────────

export function StreamingBubble({
  content,
  reasoning,
  progress,
  liveGenTps,
  genTokens,
  toolCalls = [],
}: {
  content: string
  reasoning: string
  progress: { phase: string; pct: number; tps: number } | null
  liveGenTps: number
  genTokens: number
  toolCalls?: LiveToolCall[]
}) {
  const isPrefill = !!progress && progress.phase === 'prompt'

  return (
    <div className="flex gap-3">
      <ModelAvatar />
      <div className="min-w-0 flex-1 pt-0.5">
        {reasoning && <ThinkingBlock reasoning={reasoning} streaming />}
        <ToolCallsPanel calls={toolCalls} />
        <div className="prose-tllm text-[15px] leading-[1.7] text-ink">
          {content ? <Markdown>{content}</Markdown> : (
            <span className="text-muted">
              {isPrefill ? 'Processing prompt…' : reasoning ? 'Generating…' : toolCalls.length ? 'Working…' : 'Thinking…'}
            </span>
          )}
        </div>

        {/* Prefill progress bar */}
        {isPrefill && (
          <div className="mt-2 space-y-1">
            <div className="flex items-center gap-1.5 text-[11px] text-faint">
              <span>Processing prompt</span>
              <span className="font-medium" style={{ color: 'var(--ink)' }}>{progress.pct}%</span>
              {progress.tps > 0 && <span>· {progress.tps.toFixed(0)} tok/s prefill</span>}
            </div>
            <div className="h-[3px] w-full overflow-hidden rounded-full" style={{ background: 'var(--border)' }}>
              <div
                className="h-full rounded-full transition-all duration-200"
                style={{ width: `${progress.pct}%`, background: 'var(--accent)' }}
              />
            </div>
          </div>
        )}

        {/* Live generation: running token count + tok/s */}
        {!isPrefill && (content || reasoning) && (
          <div className="mt-1 flex items-center gap-1.5 text-[11px] text-faint">
            <span className="tllm-pulse">·</span>
            {genTokens > 0 && <span className="font-medium" style={{ color: 'var(--ink)' }}>{genTokens} tok</span>}
            {liveGenTps > 0
              ? <span>· {liveGenTps.toFixed(1)} tok/s</span>
              : genTokens === 0 && <span>…</span>
            }
          </div>
        )}
      </div>
    </div>
  )
}

// ── Completed message bubble ──────────────────────────────────────────────────

export function MessageBubble({
  message,
  isLast,
  onEdit,
  onDelete,
  onRegenerate,
  editingId,
  onEditSave,
  onEditCancel,
  showThinking = true,
}: {
  message: Message
  isLast: boolean
  onEdit: (m: Message) => void
  onDelete: (m: Message) => void
  onRegenerate: () => void
  editingId: string | null
  onEditSave: (content: string) => void
  onEditCancel: () => void
  showThinking?: boolean
}) {
  const [editDraft, setEditDraft] = useState(message.content)
  const isEditing = editingId === message.id

  if (message.role === 'user') {
    return (
      <div className="group flex justify-end gap-2">
        <div className="flex flex-col items-end gap-1">
          {isEditing ? (
            <div className="w-full max-w-[75%]">
              <textarea
                autoFocus
                className="w-full resize-none rounded-[var(--radius-lg)] border border-accent bg-panel px-4 py-2.5 text-[15px] leading-[1.6] text-ink outline-none"
                rows={3}
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onEditSave(editDraft) }
                  if (e.key === 'Escape') onEditCancel()
                }}
              />
              <div className="mt-1.5 flex gap-1.5 justify-end">
                <Button size="sm" variant="ghost" onClick={onEditCancel}>Cancel</Button>
                <Button size="sm" onClick={() => onEditSave(editDraft)}>Save & Resend</Button>
              </div>
            </div>
          ) : (
            <div className="flex max-w-[75%] flex-col items-end">
              <div className="whitespace-pre-wrap rounded-[var(--radius-lg)] bg-accent px-4 py-2.5 text-[15px] leading-[1.6] text-on-accent">
                {message.content}
              </div>
              {message.attachments?.filter((a) => a.startsWith('data:image')).map((url, i) => (
                <img key={i} src={url} className="mt-2 max-h-48 max-w-xs rounded-lg object-contain" alt="attached image" />
              ))}
              {message.textAttachments?.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1 justify-end">
                  {message.textAttachments.map((name, i) => (
                    <span key={i} className="flex items-center gap-1 rounded border border-border bg-panel-2 px-2 py-0.5 text-[12px] text-muted">
                      <FileText size={11} className="shrink-0" />
                      {name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
          {!isEditing && (
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <CopyButton text={message.content} className="rounded p-1 hover:bg-panel-2" />
              <ActionBtn icon={<Pencil size={12} />}        label="Edit"   onClick={() => { setEditDraft(message.content); onEdit(message) }} />
              <ActionBtn icon={<Trash2 size={12} />}        label="Delete" onClick={() => onDelete(message)} destructive />
            </div>
          )}
        </div>
      </div>
    )
  }

  // Assistant
  const hasError = message.stats.aborted && !message.content
  const completedToolCalls: CardCall[] = (message.toolCalls ?? []).map((tc: ToolCallRecord) => ({
    id: tc.id,
    name: tc.name,
    status: tc.error ? 'error' : 'done',
    result: tc.error ?? tc.result,
  }))
  return (
    <div className="group flex gap-3">
      <ModelAvatar />
      <div className="min-w-0 flex-1 pt-0.5">
        {message.reasoning && (
          <ThinkingBlock reasoning={message.reasoning} thinkMs={message.stats.thinkMs} showThinking={showThinking} />
        )}
        <ToolCallsPanel calls={completedToolCalls} />
        {hasError ? (
          <div className="rounded-lg border px-4 py-3 text-[14px]" style={{ borderColor: 'var(--err)', color: 'var(--err)', background: 'color-mix(in srgb, var(--err) 8%, transparent)' }}>
            Generation failed or was stopped.
            {isLast && <button type="button" className="ml-3 underline" onClick={onRegenerate}>Regenerate</button>}
          </div>
        ) : (
          <div className="prose-tllm text-[15px] leading-[1.7] text-ink">
            <Markdown>{message.content}</Markdown>
          </div>
        )}
        <StatsRow stats={message.stats} />
        <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={message.content} className="rounded p-1 hover:bg-panel-2" />
          {isLast && <ActionBtn icon={<RefreshCw size={12} />} label="Regenerate" onClick={onRegenerate} />}
          <ActionBtn icon={<Trash2 size={12} />}        label="Delete"     onClick={() => onDelete(message)} destructive />
        </div>
      </div>
    </div>
  )
}

function ModelAvatar() {
  return <div className="mt-1 grid h-5 w-5 shrink-0 place-items-center rounded bg-panel-2 text-[9px] font-bold text-muted">T</div>
}

function ActionBtn({ icon, label, onClick, destructive }: { icon: ReactNode; label: string; onClick: () => void; destructive?: boolean }) {
  return (
    <button
      type="button"
      title={label}
      onClick={onClick}
      className="rounded p-1 transition-colors hover:bg-panel-2"
      style={{ color: destructive ? 'var(--err)' : 'var(--faint)' }}
    >
      {icon}
    </button>
  )
}
