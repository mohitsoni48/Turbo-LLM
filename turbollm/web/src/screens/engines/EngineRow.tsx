import { useState } from 'react'
import {
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { ApiError } from '../../lib/api'
import { useEngineMutations } from '../../lib/queries'
import { truncateMiddle } from '../../lib/utils'
import type { Engine } from '../../lib/types'
import { Badge } from '../../components/ui/badge'
import { Input } from '../../components/ui/input'
import { WithTooltip } from '../../components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog'
import { toast } from '../../components/ui/sonner'

/** Compute capability badges from probe results (per task brief):
 *  - "turbo KV" if any kvType starts with "turbo"
 *  - "parallel" if flags includes "--parallel"
 *  - count of kvTypes */
function capabilityBadges(engine: Engine) {
  const kv = engine.capabilities?.kvTypes ?? []
  const flags = engine.capabilities?.flags ?? []
  const badges: { key: string; label: string; accent?: boolean }[] = []
  if (kv.some((t) => t.startsWith('turbo'))) {
    badges.push({ key: 'turbo', label: 'turbo KV', accent: true })
  }
  if (flags.includes('--parallel')) {
    badges.push({ key: 'parallel', label: 'parallel' })
  }
  badges.push({ key: 'kvcount', label: `${kv.length} KV types` })
  return badges
}

export function EngineRow({
  engine,
}: {
  engine: Engine
}) {
  const { rename, reprobe, remove } = useEngineMutations()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(engine.name)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const badges = capabilityBadges(engine)

  const commitRename = () => {
    const name = draft.trim()
    setEditing(false)
    if (!name || name === engine.name) {
      setDraft(engine.name)
      return
    }
    rename.mutate(
      { id: engine.id, name },
      {
        onSuccess: () => toast.success('Engine renamed'),
        onError: (e) => {
          setDraft(engine.name)
          toast.error(e instanceof ApiError ? e.message : 'Could not rename engine.')
        },
      },
    )
  }

  const onReprobe = () =>
    reprobe.mutate(engine.id, {
      onSuccess: () => toast.success('Engine re-probed'),
      onError: (e) =>
        toast.error(e instanceof ApiError ? e.message : 'Could not re-probe engine.'),
    })

  const onRemove = () =>
    remove.mutate(engine.id, {
      onSuccess: () => {
        toast.success('Engine removed')
        setConfirmOpen(false)
      },
      onError: (e) => {
        setConfirmOpen(false)
        toast.error(e instanceof ApiError ? e.message : 'Could not remove engine.')
      },
    })

  return (
    <div className="rounded-[var(--radius)] border border-border bg-panel p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {editing ? (
              <Input
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') {
                    setDraft(engine.name)
                    setEditing(false)
                  }
                }}
                className="h-7 max-w-xs"
              />
            ) : (
              <span className="truncate text-sm font-semibold text-ink">{engine.name}</span>
            )}
            {engine.version && (
              <span className="shrink-0 text-[12px] text-muted">{engine.version}</span>
            )}
          </div>

          <WithTooltip label={engine.binPath} side="bottom">
            <div className="mt-1 inline-block max-w-full truncate font-mono text-[13px] text-muted">
              {truncateMiddle(engine.binPath, 56)}
            </div>
          </WithTooltip>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {badges.map((b) => (
              <Badge key={b.key} variant={b.accent ? 'accent' : 'default'}>
                {b.label}
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Engine actions"
              className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-ink"
            >
              <MoreHorizontal size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onSelect={() => {
                  setDraft(engine.name)
                  setEditing(true)
                }}
              >
                <Pencil size={14} /> Rename
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onReprobe} disabled={reprobe.isPending}>
                <RefreshCw size={14} /> Re-probe
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => setConfirmOpen(true)}>
                <Trash2 size={14} /> Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove engine?</AlertDialogTitle>
            <AlertDialogDescription>
              {engine.name} will be removed from the registry. The binary on disk is not
              deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onRemove} disabled={remove.isPending}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
