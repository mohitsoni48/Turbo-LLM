import { useState } from 'react'
import { Download, X } from 'lucide-react'
import type { Status } from '../lib/types'
import { useBackendInstall } from '../lib/queries'
import { Button } from './ui/button'

/**
 * Global banner shown while the default llama.cpp engine is being downloaded/
 * installed on first run (ADR-024), or if that provisioning failed. Reads live
 * progress from GET /api/v1/status (polled every 2s).
 */
export function EngineProvisionBanner({ status }: { status: Status | undefined }) {
  const [dismissedError, setDismissedError] = useState(false)
  const { cancel } = useBackendInstall()
  const p = status?.engineProvision
  if (!p) return null

  if (p.phase === 'error') {
    if (dismissedError) return null
    return (
      <div
        className="flex items-center gap-3 border-b px-4 py-2 text-[13px]"
        style={{ borderColor: 'var(--border)', background: 'var(--panel)', color: 'var(--err)' }}
      >
        <span className="flex-1">{p.error ?? 'Could not set up the default engine.'}</span>
        <button
          type="button"
          onClick={() => setDismissedError(true)}
          className="grid h-6 w-6 place-items-center rounded text-muted hover:text-ink"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  if (!p.active) return null

  const pct = p.pct >= 0 ? Math.round(p.pct * 100) : null
  const partTag = p.parts && p.parts > 1 ? ` · part ${p.part}/${p.parts}` : ''
  const label =
    (p.phase === 'extracting'
      ? `Installing llama.cpp engine${p.backend ? ` (${p.backend})` : ''}…`
      : `Downloading llama.cpp engine${p.backend ? ` (${p.backend})` : ''}…`) + partTag

  return (
    <div
      className="border-b px-4 py-2"
      style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
    >
      <div className="flex items-center gap-2 text-[13px] text-ink">
        <Download size={14} className="text-accent" />
        <span className="flex-1">{label}</span>
        {pct != null && <span className="tabular-nums text-muted">{pct}%</span>}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[12px]"
          onClick={() => cancel.mutate()}
          disabled={cancel.isPending}
        >
          <X size={13} /> Cancel
        </Button>
      </div>
      <div
        className="mt-1.5 h-1 w-full overflow-hidden rounded-full"
        style={{ background: 'var(--border)' }}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: pct != null ? `${pct}%` : '100%',
            background: 'var(--accent)',
            // Indeterminate (extracting): full-width subtle pulse.
            opacity: pct == null ? 0.5 : 1,
          }}
        />
      </div>
    </div>
  )
}
