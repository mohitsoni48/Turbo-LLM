import { useEffect, useRef, useState } from 'react'
import { MessageSquarePlus, Search, Trash2 } from 'lucide-react'
import type { Conversation } from '../../lib/chat-types'
import { useConversationMutations, useConversations } from '../../lib/chat-queries'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { toast } from '../../components/ui/sonner'

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000)  return 'just now'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`
  return `${Math.floor(diff / 86400_000)}d ago`
}

export function ConversationSidebar({
  activeId,
  onSelect,
  onNew,
}: {
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
}) {
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const mut = useConversationMutations()
  const convsQ = useConversations(debouncedQ || undefined)
  const convs = convsQ.data?.conversations ?? []

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 200)
    return () => clearTimeout(t)
  }, [q])

  // Ctrl+K focuses search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); searchRef.current?.focus() } }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const onDelete = (e: React.MouseEvent, conv: Conversation) => {
    e.stopPropagation()
    mut.remove.mutate(conv.id, {
      onSuccess: () => { toast.success('Conversation deleted') },
      onError:   () => { toast.error('Could not delete conversation.') },
    })
  }

  return (
    <div className="flex h-full flex-col border-r border-border bg-panel-2">
      <div className="flex items-center gap-2 px-3 py-3">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            ref={searchRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search…"
            className="h-7 pl-7 text-[12px]"
          />
        </div>
        <Button size="icon" variant="ghost" onClick={onNew} title="New chat (Ctrl+N)" className="h-7 w-7 shrink-0">
          <MessageSquarePlus size={15} />
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-1 pb-2">
        {convs.length === 0 && (
          <p className="px-3 py-4 text-[12px] text-faint">{q ? 'No results.' : 'No conversations yet.'}</p>
        )}
        {convs.map((conv) => (
          <ConvItem key={conv.id} conv={conv} active={conv.id === activeId} onSelect={onSelect} onDelete={onDelete} />
        ))}
      </div>
    </div>
  )
}

function ConvItem({
  conv,
  active,
  onSelect,
  onDelete,
}: {
  conv: Conversation
  active: boolean
  onSelect: (id: string) => void
  onDelete: (e: React.MouseEvent, conv: Conversation) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(conv.title)
  const mut = useConversationMutations()

  const commitRename = () => {
    setEditing(false)
    const title = draft.trim()
    if (!title || title === conv.title) { setDraft(conv.title); return }
    mut.update.mutate({ id: conv.id, title })
  }

  return (
    <div
      onClick={() => !editing && onSelect(conv.id)}
      className="group relative flex cursor-pointer flex-col gap-0.5 rounded-md px-3 py-2 transition-colors"
      style={{ background: active ? 'color-mix(in srgb, var(--accent) 10%, transparent)' : 'transparent' }}
    >
      {editing ? (
        <input
          autoFocus
          className="w-full bg-transparent text-[13px] font-medium text-ink outline-none"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') { setDraft(conv.title); setEditing(false) } }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className="truncate text-[13px] font-medium text-ink"
          style={{ color: active ? 'var(--accent)' : undefined }}
          onDoubleClick={(e) => { e.stopPropagation(); setEditing(true) }}
        >
          {conv.title}
        </span>
      )}
      <span className="text-[11px] text-faint">{relTime(conv.updatedAt)}</span>
      <button
        type="button"
        onClick={(e) => onDelete(e, conv)}
        className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-faint opacity-0 transition-opacity hover:text-err group-hover:opacity-100"
        title="Delete conversation"
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}
