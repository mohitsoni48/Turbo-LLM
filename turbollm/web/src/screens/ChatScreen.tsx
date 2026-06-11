import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Cpu, SendHorizontal } from 'lucide-react'
import { useStatus } from '../lib/queries'
import { chatCompletion, ApiError } from '../lib/api'
import type { ChatMessage } from '../lib/types'
import { Button } from '../components/ui/button'

/** Chat screen — simple non-streaming chat (full streaming/conversations land in a
 *  later milestone). User bubbles use the accent; assistant replies are full-width
 *  prose per spec 11 §4. */
export function ChatScreen() {
  const { data: status } = useStatus()
  const model = status?.model
  const engineState = status?.engine.state

  const ready = engineState === 'running' && !!model

  if (!model) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-md rounded-[var(--radius-lg)] border border-border bg-panel p-6 text-center shadow-[var(--shadow-1)]">
          <Cpu size={24} className="mx-auto mb-3 text-muted" />
          <h2 className="text-[16px] font-semibold text-ink">No model loaded</h2>
          <p className="mt-1 text-[13px] text-muted">
            Start an engine and load a model to begin chatting.
          </p>
          <Button asChild className="mt-4">
            <Link to="/engines">Go to Engines</Link>
          </Button>
        </div>
      </div>
    )
  }

  return <Thread modelKey={model.key} ready={ready} modelName={model.name} />
}

function Thread({
  modelKey,
  ready,
  modelName,
}: {
  modelKey: string
  ready: boolean
  modelName: string
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [messages, busy])

  const send = async () => {
    const text = input.trim()
    if (!text || busy || !ready) return
    const next: ChatMessage[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setInput('')
    setBusy(true)
    try {
      const data = await chatCompletion({ model: modelKey, messages: next })
      const reply = data.choices?.[0]?.message?.content ?? '(no response)'
      setMessages([...next, { role: 'assistant', content: reply }])
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Request failed.'
      setMessages([...next, { role: 'assistant', content: msg }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex w-full max-w-[768px] flex-col gap-5 px-6 py-6">
          {messages.length === 0 && (
            <p className="py-12 text-center text-[13px] text-muted">
              {ready ? 'Send a message to begin.' : 'Waiting for the model to be ready…'}
            </p>
          )}
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] whitespace-pre-wrap rounded-[var(--radius-lg)] bg-accent px-4 py-2 text-[15px] leading-[1.6] text-on-accent">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex gap-3">
                <div className="mt-1 grid h-4 w-4 shrink-0 place-items-center rounded-[4px] bg-panel-2 text-[9px] font-bold text-muted">
                  T
                </div>
                <div className="min-w-0 flex-1 whitespace-pre-wrap text-[15px] leading-[1.6] text-ink">
                  {m.content}
                </div>
              </div>
            ),
          )}
          {busy && (
            <div className="flex gap-3">
              <div className="mt-1 grid h-4 w-4 shrink-0 place-items-center rounded-[4px] bg-panel-2 text-[9px] font-bold text-muted">
                T
              </div>
              <div className="text-[15px] leading-[1.6] text-muted">Thinking…</div>
            </div>
          )}
        </div>
      </div>

      <div className="px-6 pb-6">
        <div className="mx-auto w-full max-w-[768px]">
          <div className="flex items-end gap-2 rounded-[var(--radius-lg)] border border-border bg-panel p-2 shadow-[var(--shadow-2)]">
            <textarea
              className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-ink outline-none placeholder:text-faint"
              rows={1}
              placeholder={ready ? 'Message the model…' : 'Model not ready yet…'}
              value={input}
              disabled={!ready || busy}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
            />
            <Button
              size="icon"
              aria-label="Send message"
              onClick={() => void send()}
              disabled={!ready || busy || !input.trim()}
            >
              <SendHorizontal size={16} />
            </Button>
          </div>
          <p className="mt-1.5 px-1 text-[12px] text-faint">
            {modelName} · Enter to send
          </p>
        </div>
      </div>
    </div>
  )
}
