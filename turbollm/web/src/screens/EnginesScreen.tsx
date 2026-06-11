import { Cpu } from 'lucide-react'
import { useEngines, useStatus } from '../lib/queries'
import { ApiError } from '../lib/api'
import { useUiStore } from '../stores/ui'
import { ScreenHeader, InlineError, EmptyState } from '../components/common'
import { Skeleton } from '../components/ui/skeleton'
import { AddEngineDialog } from './engines/AddEngineDialog'
import { EngineRow } from './engines/EngineRow'
import { EngineStatusHeader } from './engines/EngineStatusHeader'
import { EngineLogPanel } from './engines/EngineLogPanel'

/** Engines screen (spec 03 §9): status header + registered list + add dialog +
 *  live log panel. Handles loading / empty / error / populated states. */
export function EnginesScreen() {
  const enginesQ = useEngines()
  const { data: status } = useStatus()
  const logPanelOpen = useUiStore((s) => s.logPanelOpen)
  const setLogPanelOpen = useUiStore((s) => s.setLogPanelOpen)

  const list = enginesQ.data
  const activeId = list?.activeEngineId ?? ''
  const activeEngine = list?.engines.find((e) => e.id === activeId) ?? null

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-6">
      <ScreenHeader
        title="Engines"
        description="Manage llama-server compatible binaries and the running engine."
        actions={<AddEngineDialog />}
      />

      <div className="flex flex-col gap-4">
        {/* Status header — only meaningful once an engine is active */}
        {activeEngine && (
          <EngineStatusHeader status={status} activeEngineName={activeEngine.name} />
        )}

        {/* Log panel */}
        {activeEngine && (
          <EngineLogPanel open={logPanelOpen} onOpenChange={setLogPanelOpen} />
        )}

        {/* Registered engines list */}
        <section className="flex flex-col gap-2">
          {enginesQ.isLoading && (
            <>
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </>
          )}

          {enginesQ.isError && (
            <InlineError
              message={
                enginesQ.error instanceof ApiError
                  ? enginesQ.error.message
                  : 'Could not load engines.'
              }
              onRetry={() => void enginesQ.refetch()}
            />
          )}

          {!enginesQ.isLoading && !enginesQ.isError && list && list.engines.length === 0 && (
            <EmptyState
              icon={<Cpu size={24} />}
              message="No engines registered yet. Point TurboLLM at any llama-server compatible binary — mainline llama.cpp, or any community fork — to get started."
              action={<AddEngineDialog />}
            />
          )}

          {list?.engines.map((engine) => (
            <EngineRow key={engine.id} engine={engine} active={engine.id === activeId} />
          ))}
        </section>
      </div>
    </div>
  )
}
