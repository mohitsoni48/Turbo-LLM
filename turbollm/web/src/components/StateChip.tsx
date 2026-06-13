import { cn } from '../lib/utils'
import type { EngineState } from '../lib/types'

const LABELS: Record<EngineState, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  error: 'Error',
}

// Color per state (spec 11 §3): stopped=muted, starting=warn pulse, running=ok,
// stopping=warn, error=err.
const DOT_COLOR: Record<EngineState, string> = {
  stopped: 'var(--muted)',
  starting: 'var(--warn)',
  running: 'var(--ok)',
  stopping: 'var(--warn)',
  error: 'var(--err)',
}

/** Pill chip with a colored dot + label reflecting the engine state. With
 *  `dotOnly`, renders just the colored dot (collapsed nav rail) — the label is
 *  still exposed via `aria-label` for screen readers. */
export function StateChip({
  state,
  className,
  dotOnly = false,
}: {
  state: EngineState
  className?: string
  dotOnly?: boolean
}) {
  const pulse = state === 'starting'
  if (dotOnly) {
    return (
      <span
        className={cn('inline-flex h-2 w-2 rounded-full', pulse && 'tllm-pulse', className)}
        style={{ background: DOT_COLOR[state] }}
        aria-label={LABELS[state]}
      />
    )
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-border bg-panel-2 px-2 py-0.5 text-[12px] leading-none text-muted',
        className,
      )}
    >
      <span
        className={cn('h-2 w-2 rounded-full', pulse && 'tllm-pulse')}
        style={{ background: DOT_COLOR[state] }}
      />
      {LABELS[state]}
    </span>
  )
}
