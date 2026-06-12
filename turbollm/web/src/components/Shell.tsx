import { type ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import {
  Boxes,
  Cpu,
  MessageSquare,
  Settings2,
} from 'lucide-react'
import { cn } from '../lib/utils'
import type { Status } from '../lib/types'
import { StateChip } from './StateChip'
import { EngineProvisionBanner } from './EngineProvisionBanner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from './ui/tooltip'
import { Badge } from './ui/badge'

const NAV = [
  { to: '/chat', label: 'Chat', icon: MessageSquare },
  { to: '/models', label: 'Models', icon: Boxes },
  { to: '/engines', label: 'Engines', icon: Cpu },
  { to: '/settings', label: 'Settings', icon: Settings2 },
] as const

export function Shell({
  status,
  online,
  version,
  children,
}: {
  status: Status | undefined
  online: boolean
  version: string
  children: ReactNode
}) {
  return (
    <div className="flex h-full">
      <NavRail online={online} version={version} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar status={status} />
        <EngineProvisionBanner status={status} />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  )
}

function NavRail({ online, version }: { online: boolean; version: string }) {
  return (
    <nav className="flex w-16 shrink-0 flex-col items-center bg-panel-2 py-3">
      <div
        className="mb-4 grid h-7 w-7 place-items-center rounded-[var(--radius-sm)] text-[14px] font-bold text-on-accent"
        style={{ background: 'var(--accent)' }}
        aria-hidden
      >
        T
      </div>
      <ul className="flex flex-1 flex-col items-center gap-1">
        {NAV.map(({ to, label, icon: Icon }) => (
          <li key={to}>
            <Tooltip>
              <TooltipTrigger asChild>
                <NavLink
                  to={to}
                  aria-label={label}
                  className={({ isActive }: { isActive: boolean }) =>
                    cn(
                      'grid h-10 w-10 place-items-center rounded-[var(--radius-sm)] transition-colors',
                      isActive
                        ? 'bg-panel text-accent shadow-[var(--shadow-1)]'
                        : 'text-muted hover:text-ink',
                    )
                  }
                >
                  <Icon size={20} />
                </NavLink>
              </TooltipTrigger>
              <TooltipContent side="right">{label}</TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-col items-center gap-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={cn('h-2 w-2 rounded-full')}
              style={{ background: online ? 'var(--ok)' : 'var(--muted)' }}
              aria-label={online ? 'Daemon connected' : 'Daemon offline'}
            />
          </TooltipTrigger>
          <TooltipContent side="right">
            {online ? 'Daemon connected' : 'Daemon offline'}
          </TooltipContent>
        </Tooltip>
        <span className="text-[10px] text-faint">{version}</span>
      </div>
    </nav>
  )
}

function TopBar({ status }: { status: Status | undefined }) {
  const engineState = status?.engine.state ?? 'stopped'
  const model = status?.model

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-bg px-4">
      {/* Model selector (read-only display in this milestone; full picker later) */}
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm">
        {model ? (
          <>
            <span className="font-medium text-ink">{model.name}</span>
            <Badge variant="mono">{model.quant}</Badge>
          </>
        ) : (
          <span className="text-muted">No model loaded</span>
        )}
      </div>

      {/* Engine is auto-managed (starts on model load, stops before switching);
          status is display-only — no manual Start/Stop controls. */}
      <div className="ml-auto flex items-center gap-2">
        <StateChip state={engineState} />
      </div>
    </header>
  )
}
