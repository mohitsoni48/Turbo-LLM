import { Check, ChevronDown, CircleSlash, Cpu, Loader2 } from 'lucide-react'
import type { ModelEntry } from '../lib/types'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

/**
 * Model selector + eject control. Lists discovered models; selecting one loads it
 * (the engine auto-starts), and "Eject" stops the running engine. Shared by the
 * Chat and Models screens.
 */
export function ModelLoadMenu({
  models,
  loadedKey,
  loadedName,
  pending,
  onLoad,
  onEject,
  align = 'start',
}: {
  models: ModelEntry[]
  loadedKey?: string | null
  loadedName?: string | null
  pending?: boolean
  onLoad: (key: string) => void
  onEject: () => void
  align?: 'start' | 'end'
}) {
  const loadable = models.filter((m) => !m.incomplete && !m.parseError)
  const label = loadedName || (loadedKey ? 'Loaded model' : 'Load a model')

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-8 max-w-[260px] items-center gap-1.5 rounded-md border border-border bg-panel px-2.5 text-[13px] text-ink transition-colors hover:border-[color:var(--accent)] disabled:opacity-60"
        disabled={pending}
      >
        {pending ? (
          <Loader2 size={14} className="animate-spin text-muted" />
        ) : (
          <Cpu size={14} className={loadedKey ? 'text-accent' : 'text-muted'} />
        )}
        <span className="truncate">{label}</span>
        <ChevronDown size={14} className="shrink-0 text-muted" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="max-h-[60vh] w-[280px] overflow-y-auto">
        <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
          {loadable.length ? 'Load a model' : 'No models found'}
        </div>
        {loadable.map((m) => {
          const active = m.key === loadedKey
          return (
            <DropdownMenuItem
              key={m.key}
              onSelect={() => !active && onLoad(m.key)}
              className="flex items-center gap-2"
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {active && <Check size={14} className="text-accent" />}
              </span>
              <span className="min-w-0 flex-1 truncate">{m.name}</span>
              <span className="shrink-0 text-[11px] uppercase text-faint">
                {m.format === 'mlx' ? 'MLX' : m.quant}
              </span>
            </DropdownMenuItem>
          )
        })}
        {loadedKey && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onEject} style={{ color: 'var(--err)' }}>
              <CircleSlash size={14} /> Eject model
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
