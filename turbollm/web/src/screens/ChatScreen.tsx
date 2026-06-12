import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowDown, Cpu, SendHorizontal, Square } from 'lucide-react'
import { sendMessage } from '../lib/chat-api'
import { useConversation, useConversationMutations } from '../lib/chat-queries'
import { useStatus } from '../lib/queries'
import type { Message } from '../lib/chat-types'
import { ApiError } from '../lib/api'
import { Button } from '../components/ui/button'
import { Link } from 'react-router-dom'
import { toast } from '../components/ui/sonner'
import { useQueryClient } from '@tanstack/react-query'
import { MessageBubble, StreamingBubble } from './chat/MessageBubble'
import { ConversationSidebar } from './chat/ConversationSidebar'

// Streaming state
interface LiveState {
  assistantId: string
  content: string
  reasoning: string
  progress: { phase: string; pct: number; tps: number } | null
}

export function ChatScreen() {
  const { data: status } = useStatus()
  const model = status?.model
  const engineState = status?.engine.state

  const [activeId, setActiveId] = useState<string | null>(null)
  const [live, setLive] = useState<LiveState | null>(null)
  const [input, setInput] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const userScrolledUp = useRef(false)
  const qc = useQueryClient()
  const mut = useConversationMutations()

  const convQ = useConversation(activeId)
  const conv = convQ.data
  const messages = conv?.messages ?? []

  // Auto-resize textarea
  const autoResize = () => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }

  // Autoscroll
  const scrollToBottom = useCallback((force = false) => {
    const el = scrollerRef.current
    if (!el) return
    if (force || !userScrolledUp.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      setShowScrollBtn(false)
    }
  }, [])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const handler = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      userScrolledUp.current = !atBottom
      setShowScrollBtn(!atBottom && !!live)
    }
    el.addEventListener('scroll', handler)
    return () => el.removeEventListener('scroll', handler)
  }, [live])

  useEffect(() => {
    if (live) scrollToBottom()
  }, [live, scrollToBottom])

  // Ctrl+N new chat, Esc stop
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') { e.preventDefault(); handleNew() }
      if (e.key === 'Escape' && live) { void handleStop() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })

  const handleNew = () => {
    setActiveId(null)
    setInput('')
    setLive(null)
    inputRef.current?.focus()
  }

  const handleSelect = (id: string) => {
    if (live) { abortRef.current?.abort(); setLive(null) }
    setActiveId(id)
    setEditingId(null)
    userScrolledUp.current = false
    setTimeout(() => scrollToBottom(true), 50)
  }

  const handleStop = async () => {
    abortRef.current?.abort()
    if (activeId) await mut.stop.mutateAsync(activeId).catch(() => {})
  }

  const send = async (overrideInput?: string) => {
    const text = (overrideInput ?? input).trim()
    if (!text || live) return
    if (engineState !== 'running' || !model) { toast.error('Load a model first.'); return }

    setInput('')
    setTimeout(autoResize, 0)
    userScrolledUp.current = false

    try {
      // Create conversation on first message
      let convId = activeId
      if (!convId) {
        const newConv = await mut.create.mutateAsync({ modelKey: model.key })
        convId = newConv.id
        setActiveId(convId)
      }

      const ac = new AbortController()
      abortRef.current = ac

      const gen = sendMessage(convId, text, ac.signal)

      for await (const evt of gen) {
        if (evt.event === 'meta') {
          setLive({ assistantId: evt.data.assistantMessageId, content: '', reasoning: '', progress: null })
          // Optimistically add user msg to UI by invalidating
          void qc.invalidateQueries({ queryKey: ['conversation', convId] })
        } else if (evt.event === 'progress') {
          setLive((l) => l ? { ...l, progress: { phase: evt.data.phase, pct: evt.data.pct, tps: evt.data.tps } } : l)
        } else if (evt.event === 'reasoning') {
          setLive((l) => l ? { ...l, reasoning: l.reasoning + evt.data.delta, progress: null } : l)
        } else if (evt.event === 'delta') {
          setLive((l) => l ? { ...l, content: l.content + evt.data.delta, progress: null } : l)
        } else if (evt.event === 'done') {
          setLive(null)
          void qc.invalidateQueries({ queryKey: ['conversation', convId] })
          void qc.invalidateQueries({ queryKey: ['conversations'] })
          setTimeout(() => scrollToBottom(true), 80)
        } else if (evt.event === 'error') {
          setLive(null)
          void qc.invalidateQueries({ queryKey: ['conversation', convId] })
          toast.error(evt.data.message)
        }
      }
    } catch (e) {
      setLive(null)
      if ((e as Error)?.name !== 'AbortError') {
        toast.error(e instanceof ApiError ? e.message : 'Request failed.')
      }
      if (activeId) void qc.invalidateQueries({ queryKey: ['conversation', activeId] })
    }
  }

  const handleEditSave = (msgId: string, content: string) => {
    if (!activeId) return
    setEditingId(null)
    mut.editMsg.mutate({ convId: activeId, msgId, content }, {
      onSuccess: () => { userScrolledUp.current = false; void send(undefined) },
      onError: () => toast.error('Could not edit message.'),
    })
  }

  const handleRegenerate = async () => {
    if (!activeId || live) return
    await mut.regenerate.mutateAsync(activeId).catch(() => {})
    const last = messages.filter((m) => m.role === 'user').at(-1)
    if (last) await send(last.content)
  }

  const handleCopy = (m: Message) => {
    void navigator.clipboard.writeText(m.content).then(() => toast.success('Copied'))
  }

  const handleDelete = (m: Message) => {
    if (!activeId) return
    mut.deleteMsg.mutate({ convId: activeId, msgId: m.id }, {
      onError: () => toast.error('Could not delete message.'),
    })
  }

  // Context meter
  const lastStats = messages.findLast((m) => m.role === 'assistant')?.stats
  const ctxUsed  = lastStats?.ctxUsed ?? 0
  const ctxMax   = lastStats?.ctxMax  ?? model?.ctx ?? 0
  const ctxPct   = ctxMax > 0 ? ctxUsed / ctxMax : 0

  const ready = engineState === 'running' && !!model

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar */}
      <div className="w-56 shrink-0">
        <ConversationSidebar activeId={activeId} onSelect={handleSelect} onNew={handleNew} />
      </div>

      {/* Thread */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* No model loaded */}
        {!model && (
          <div className="flex flex-1 items-center justify-center p-6">
            <div className="w-full max-w-md rounded-[var(--radius-lg)] border border-border bg-panel p-6 text-center shadow-[var(--shadow-1)]">
              <Cpu size={24} className="mx-auto mb-3 text-muted" />
              <h2 className="text-[16px] font-semibold text-ink">No model loaded</h2>
              <p className="mt-1 text-[13px] text-muted">Load a model from the Models screen to start chatting.</p>
              <Button asChild className="mt-4"><Link to="/models">Go to Models</Link></Button>
            </div>
          </div>
        )}

        {model && (
          <>
            {/* Message list */}
            <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
              <div className="mx-auto flex w-full max-w-[768px] flex-col gap-6 px-6 py-6">
                {/* Empty state */}
                {messages.length === 0 && !live && (
                  <div className="flex flex-col items-center gap-3 py-16">
                    <p className="text-[15px] font-medium text-ink">{model.name}</p>
                    <div className="flex flex-wrap justify-center gap-2">
                      {['Explain something to me', 'Help me write', 'Review this code'].map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => { setInput(s); setTimeout(() => inputRef.current?.focus(), 0) }}
                          className="rounded-full border border-border px-4 py-1.5 text-[13px] text-muted hover:border-accent hover:text-ink transition-colors"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Messages */}
                {messages.map((m, i) => (
                  <MessageBubble
                    key={m.id}
                    message={m}
                    isLast={i === messages.length - 1 && !live}
                    onCopy={handleCopy}
                    onEdit={(msg) => setEditingId(msg.id)}
                    onDelete={handleDelete}
                    onRegenerate={handleRegenerate}
                    editingId={editingId}
                    onEditSave={(content) => handleEditSave(m.id, content)}
                    onEditCancel={() => setEditingId(null)}
                  />
                ))}

                {/* Streaming bubble */}
                {live && (
                  <StreamingBubble content={live.content} reasoning={live.reasoning} progress={live.progress} />
                )}

                <div ref={bottomRef} />
              </div>
            </div>

            {/* Scroll-to-bottom pill */}
            {showScrollBtn && (
              <button
                type="button"
                onClick={() => { userScrolledUp.current = false; scrollToBottom(true) }}
                className="absolute bottom-28 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-border bg-panel px-3 py-1.5 text-[12px] text-muted shadow-[var(--shadow-1)] hover:text-ink"
              >
                <ArrowDown size={13} /> Jump to latest
              </button>
            )}

            {/* Composer area */}
            <div className="px-6 pb-5">
              <div className="mx-auto w-full max-w-[768px]">
                {/* Context meter */}
                {ctxMax > 0 && ctxUsed > 0 && (
                  <div className="mb-2 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full" style={{ background: 'var(--border)' }}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${Math.min(100, ctxPct * 100).toFixed(1)}%`,
                          background: ctxPct > 0.9 ? 'var(--err)' : ctxPct > 0.7 ? 'var(--warn)' : 'var(--accent)',
                        }}
                      />
                    </div>
                    <span
                      className="shrink-0 text-[11px] text-faint"
                      title={ctxPct > 0.9 ? 'Context almost full — older messages may be truncated' : undefined}
                      style={{ color: ctxPct > 0.9 ? 'var(--err)' : ctxPct > 0.7 ? 'var(--warn)' : undefined }}
                    >
                      {ctxUsed.toLocaleString()} / {ctxMax.toLocaleString()}
                    </span>
                  </div>
                )}

                <div className="flex items-end gap-2 rounded-[var(--radius-lg)] border border-border bg-panel p-2 shadow-[var(--shadow-2)] focus-within:border-[color:var(--accent)]">
                  <textarea
                    ref={inputRef}
                    rows={1}
                    className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] text-ink outline-none placeholder:text-faint"
                    placeholder={ready ? `Message ${model.name}…` : 'Model not ready…'}
                    value={input}
                    disabled={!ready || !!live || !!editingId}
                    onChange={(e) => { setInput(e.target.value); autoResize() }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send() }
                      if (e.key === 'ArrowUp' && !input && !live) {
                        const lastUser = messages.findLast((m) => m.role === 'user')
                        if (lastUser) { setEditingId(lastUser.id) }
                      }
                    }}
                  />
                  {live ? (
                    <Button size="icon" variant="outline" onClick={() => void handleStop()} title="Stop generation (Esc)">
                      <Square size={15} />
                    </Button>
                  ) : (
                    <Button size="icon" onClick={() => void send()} disabled={!ready || !input.trim() || !!editingId} aria-label="Send">
                      <SendHorizontal size={15} />
                    </Button>
                  )}
                </div>
                <p className="mt-1.5 px-1 text-[11px] text-faint">
                  {model.name} · Enter to send · Shift+Enter for newline
                </p>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
