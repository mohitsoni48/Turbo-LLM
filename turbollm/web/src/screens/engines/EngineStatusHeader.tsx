import { Copy } from 'lucide-react'
import type { Status } from '../../lib/types'
import { Button } from '../../components/ui/button'
import { StateChip } from '../../components/StateChip'
import { toast } from '../../components/ui/sonner'

/** Active engine status card: name + state chip + loading elapsed + error log.
 *  Start/Stop/Restart are intentionally absent — the engine is managed automatically
 *  when models are loaded from the Models screen. */
export function EngineStatusHeader({
  status,
  activeEngineName,
}: {
  status: Status | undefined
  activeEngineName: string | null
}) {
  const state = status?.engine.state ?? 'stopped'
  const error = status?.engine.error
  const elapsedMs = status?.model?.loadElapsedMs

  const copyLog = async () => {
    const text = (error?.logTail ?? []).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Log copied to clipboard')
    } catch {
      toast.error('Could not copy log')
    }
  }

  return (
    <div className="rounded-[var(--radius)] border border-[color:var(--accent)] bg-panel p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <div className="text-[12px] text-muted">Active engine</div>
          <div className="text-sm font-semibold text-ink">
            {activeEngineName ?? 'None active'}
          </div>
        </div>
        <StateChip state={state} />
        {state === 'starting' && elapsedMs != null && (
          <span className="text-[13px] text-muted">
            Loading model… ({Math.round(elapsedMs / 1000)}s)
          </span>
        )}
        {state === 'running' && status?.model && (
          <span className="text-[13px] text-muted truncate">{status.model.name}</span>
        )}
      </div>

      {state === 'error' && error && (
        <div className="mt-3">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[13px] font-medium" style={{ color: 'var(--err)' }}>
              {error.message}
              {error.exitCode != null && ` (exit ${error.exitCode})`}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void copyLog()}>
              <Copy size={14} /> Copy
            </Button>
          </div>
          <pre
            className="max-h-48 overflow-auto rounded-md px-3 py-2 font-mono text-[12px] leading-[1.5]"
            style={{ background: 'var(--log-bg)', color: 'var(--log-err-ink)' }}
          >
            {(error.logTail ?? []).join('\n') || 'No log output captured.'}
          </pre>
        </div>
      )}
    </div>
  )
}
