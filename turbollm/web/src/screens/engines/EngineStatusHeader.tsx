import { CircleSlash, Copy } from 'lucide-react'
import type { Status } from '../../lib/types'
import { useModelActions } from '../../lib/queries'
import { ApiError } from '../../lib/api'
import { Button } from '../../components/ui/button'
import { StateChip } from '../../components/StateChip'
import { toast } from '../../components/ui/sonner'

/** Active engine status card: name + state chip + loading elapsed + error log,
 *  plus a Stop control that unloads the model and shuts the engine process down.
 *  (No manual Start — the engine starts automatically when a model is loaded.) */
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
  const actions = useModelActions()
  const canStop = state === 'running' || state === 'starting'

  const onStop = () =>
    actions.eject.mutate(undefined, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not stop the engine.'),
    })

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
        {canStop && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={onStop}
            disabled={actions.eject.isPending}
            title="Stop the engine and unload the model"
          >
            <CircleSlash size={14} />
            Stop & unload
          </Button>
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
