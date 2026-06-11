import { Copy, Play, RotateCcw, Square } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { useEngineMutations } from '../../lib/queries'
import type { Status } from '../../lib/types'
import { Button } from '../../components/ui/button'
import { StateChip } from '../../components/StateChip'
import { toast } from '../../components/ui/sonner'

/** Status header for the active engine: name + state chip + Start/Stop/Restart,
 *  loading-elapsed while starting, and the error logTail block when in error
 *  (spec 03 §9). */
export function EngineStatusHeader({
  status,
  activeEngineName,
}: {
  status: Status | undefined
  activeEngineName: string | null
}) {
  const { start, stop, restart } = useEngineMutations()
  const state = status?.engine.state ?? 'stopped'
  const error = status?.engine.error
  const elapsedMs = status?.model?.loadElapsedMs

  const handle = (
    mutate: { mutate: (v: void, o?: { onError?: (e: unknown) => void }) => void },
    failMsg: string,
  ) =>
    mutate.mutate(undefined, {
      onError: (e: unknown) =>
        toast.error(e instanceof ApiError ? e.message : failMsg),
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

  const running = state === 'running'
  const starting = state === 'starting'
  const busy = start.isPending || stop.isPending || restart.isPending

  return (
    <div className="rounded-[var(--radius)] border border-[color:var(--accent)] bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div>
            <div className="text-[12px] text-muted">Active engine</div>
            <div className="text-sm font-semibold text-ink">
              {activeEngineName ?? 'None active'}
            </div>
          </div>
          <StateChip state={state} />
          {starting && elapsedMs != null && (
            <span className="text-[13px] text-muted">
              Loading model… ({Math.round(elapsedMs / 1000)}s)
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => handle(start, 'Could not start engine.')}
            disabled={busy || running || starting || !activeEngineName}
          >
            <Play size={14} /> Start
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => handle(stop, 'Could not stop engine.')}
            disabled={busy || state === 'stopped' || state === 'stopping'}
          >
            <Square size={14} /> Stop
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => handle(restart, 'Could not restart engine.')}
            disabled={busy || !running}
          >
            <RotateCcw size={14} /> Restart
          </Button>
        </div>
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
