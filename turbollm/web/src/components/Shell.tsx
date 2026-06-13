import { type ReactNode, useEffect } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { Boxes, Code2, Cpu, MessageSquare, Settings2 } from 'lucide-react'
import { cn } from '../lib/utils'
import type { Status } from '../lib/types'
import { StateChip } from './StateChip'
import { BoltMark } from './Logo'
import { EngineProvisionBanner } from './EngineProvisionBanner'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from './ui/tooltip'

const NAV = [
  { to: '/chat',      label: 'Chat',      icon: MessageSquare },
  { to: '/models',    label: 'Models',    icon: Boxes },
  { to: '/engines',   label: 'Engines',   icon: Cpu },
  { to: '/developer', label: 'Developer', icon: Code2 },
  { to: '/settings',  label: 'Settings',  icon: Settings2 },
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
      <NavRail online={online} version={version} className="hidden md:flex" />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar status={status} />
        <EngineProvisionBanner status={status} />
        <main className="min-h-0 flex-1 overflow-auto">{children}</main>
        <MobileNav />
      </div>
    </div>
  )
}

function NavRail({
  online,
  version,
  className,
}: {
  online: boolean
  version: string
  className?: string
}) {
  const { pathname } = useLocation()
  const navigate = useNavigate()

  // Keyboard shortcuts: Ctrl+1–5 (or Cmd+1–5 on Mac) navigate to the
  // corresponding NAV item. Ignored when focus is in an editable element.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (!e.ctrlKey && !e.metaKey) return
      const idx = parseInt(e.key, 10) - 1
      if (idx < 0 || idx >= NAV.length) return
      // Don't hijack number input in text fields / chat composer.
      const tag = (document.activeElement as HTMLElement | null)?.tagName ?? ''
      const editable = (document.activeElement as HTMLElement | null)?.isContentEditable
      if (tag === 'INPUT' || tag === 'TEXTAREA' || editable) return
      e.preventDefault()
      navigate(NAV[idx].to)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [navigate])

  return (
    <nav
      className={cn(
        // Icon-only at md–lg (w-16). At xl+ expand to show labels (w-48).
        'flex w-16 shrink-0 flex-col items-center bg-panel-2 py-3',
        'xl:w-48 xl:items-start xl:px-3',
        className,
      )}
    >
      {/* Logo */}
      <div className="mb-4 flex w-full items-center justify-center gap-2 xl:justify-start xl:pl-1">
        <div
          className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-sm)] text-on-accent"
          style={{ background: 'var(--accent)' }}
          aria-hidden
        >
          <BoltMark className="h-4 w-4" />
        </div>
        <span className="hidden text-[15px] font-semibold tracking-tight xl:inline" aria-hidden>
          <span className="text-ink">Turbo</span>
          <span className="text-accent">LLM</span>
        </span>
      </div>

      {/* Nav items — icon-only below xl; icon + label at xl+.
          NOTE: TooltipTrigger asChild wraps the link in a Radix Slot, which merges
          `className` as a STRING — a NavLink function-className would be stringified
          and never run. So compute active state here and pass a plain string.
          At xl+ the label is visible so the tooltip is hidden via pointer-events-none. */}
      <ul className="flex flex-1 flex-col items-center gap-1 xl:w-full xl:items-stretch">
        {NAV.map(({ to, label, icon: Icon }) => {
          const isActive = pathname === to || pathname.startsWith(`${to}/`)
          return (
            <li key={to}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    to={to}
                    aria-label={label}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)] transition-colors',
                      // At xl+ stretch to full rail width, left-align icon+label
                      'xl:w-full xl:justify-start xl:gap-3 xl:px-3',
                      isActive
                        ? 'bg-accent/12 text-accent'
                        : 'text-muted hover:bg-panel hover:text-ink',
                    )}
                  >
                    <Icon size={20} className="shrink-0" />
                    <span className="hidden xl:inline text-sm font-medium">{label}</span>
                  </Link>
                </TooltipTrigger>
                {/* Hide tooltip at xl+ since label is already visible */}
                <TooltipContent side="right" className="xl:hidden">{label}</TooltipContent>
              </Tooltip>
            </li>
          )
        })}
      </ul>

      {/* Online indicator (version in tooltip) */}
      <div className="mt-2 flex w-full flex-col items-center xl:items-start xl:pl-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="h-2 w-2 rounded-full"
              style={{ background: online ? 'var(--ok)' : 'var(--muted)' }}
              aria-label={online ? 'Daemon connected' : 'Daemon offline'}
            />
          </TooltipTrigger>
          <TooltipContent side="right">
            {(online ? 'Daemon connected' : 'Daemon offline') + ` · ${version}`}
          </TooltipContent>
        </Tooltip>
      </div>
    </nav>
  )
}

function TopBar({ status }: { status: Status | undefined }) {
  const engineState = status?.engine.state ?? 'stopped'
  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-bg px-4">
      <div className="flex-1" />
      <StateChip state={engineState} />
    </header>
  )
}

function MobileNav() {
  return (
    <nav className="flex shrink-0 border-t border-border bg-panel-2 md:hidden">
      {NAV.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }: { isActive: boolean }) =>
            cn(
              'flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[10px] transition-colors',
              isActive ? 'text-accent' : 'text-muted',
            )
          }
        >
          <Icon size={20} />
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
