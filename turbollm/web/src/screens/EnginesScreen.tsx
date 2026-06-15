import { useState } from 'react'
import { useEngines, useEngineBackends, useStatus } from '../lib/queries'
import { ApiError } from '../lib/api'
import { useUiStore } from '../stores/ui'
import { ScreenHeader, InlineError } from '../components/common'
import { Skeleton } from '../components/ui/skeleton'
import { AddEngineDialog } from './engines/AddEngineDialog'
import { EngineRow } from './engines/EngineRow'
import { EngineSelector } from './engines/EngineSelector'
import { EngineHelp } from './engines/EngineHelp'
import { EngineStatusHeader } from './engines/EngineStatusHeader'
import { EngineLogPanel } from './engines/EngineLogPanel'
import { DiscoverEngines, LlamaCppBackendRows, MlxEngineRow } from './engines/ManagedEngines'

/** Auto-downloaded official llama.cpp builds live in `<config>/engines/llama.cpp-<tag>-<backend>/`;
 *  everything else in the registry is a user-supplied (BYO) fork — its own engine. */
const isOfficialLlama = (binPath: string) => /[\\/]engines[\\/]llama\.cpp-/.test(binPath)

/**
 * Engines screen. Selection is two levels (ADR-025+): pick the Engine (runtime /
 * fork) then its Build (GPU backend). The management list below is grouped the
 * same way — official builds under "Official llama.cpp", each fork on its own.
 */
export function EnginesScreen() {
  const enginesQ = useEngines()
  const { data: status } = useStatus()
  const provisioning = !!status?.engineProvision?.active
  const backendsQ = useEngineBackends(provisioning)
  const logPanelOpen = useUiStore((s) => s.logPanelOpen)
  const setLogPanelOpen = useUiStore((s) => s.setLogPanelOpen)

  const list = enginesQ.data
  const activeId = list?.activeEngineId ?? ''
  const activeEngine = list?.engines.find((e) => e.id === activeId) ?? null
  // Forks = user-supplied engines (not the managed official builds, not MLX).
  const forks = (list?.engines ?? []).filter(
    (e) => e.kind !== 'mlx' && !isOfficialLlama(e.binPath),
  )

  // Which engine's builds the management list below shows. Defaults to the
  // active engine; the top Engine dropdown overrides it. Keys: 'official',
  // 'mlx', or `custom:<forkId>` (matching EngineSelector's group keys).
  const [viewKey, setViewKey] = useState<string | null>(null)
  const activeGroupKey = !activeEngine
    ? 'official'
    : activeEngine.kind === 'mlx'
      ? 'mlx'
      : isOfficialLlama(activeEngine.binPath)
        ? 'official'
        : `custom:${activeEngine.id}`
  const selectedKey = viewKey ?? activeGroupKey
  const selectedFork = selectedKey.startsWith('custom:')
    ? (forks.find((e) => `custom:${e.id}` === selectedKey) ?? null)
    : null

  return (
    <div className="w-full px-6 py-6">
      <ScreenHeader
        title="Engines"
        description="Pick an engine and its build above. The list below is for downloading and managing them."
        actions={<AddEngineDialog />}
      />

      <div className="flex flex-col gap-4">
        {/* Running-engine status + Stop & unload */}
        {activeEngine && <EngineStatusHeader status={status} activeEngineName={activeEngine.name} />}

        {/* How engines & builds work */}
        <EngineHelp />

        {/* Engine → Build selector */}
        <div className="rounded-lg border border-border bg-panel p-4">
          <div className="mb-3">
            <div className="text-[14px] font-medium text-ink">Active engine</div>
            <div className="text-[12px] text-muted">
              One build runs at a time — pick the engine, then its build.
            </div>
          </div>
          <EngineSelector
            list={list}
            backends={backendsQ.data}
            provisioning={provisioning}
            selectedKey={selectedKey}
            onSelect={setViewKey}
          />
        </div>

        {enginesQ.isLoading ? (
          <section className="flex flex-col gap-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </section>
        ) : enginesQ.isError ? (
          <InlineError
            message={enginesQ.error instanceof ApiError ? enginesQ.error.message : 'Could not load engines.'}
            onRetry={() => void enginesQ.refetch()}
          />
        ) : (
          /* Builds for the selected engine only — the list follows the top
             Engine dropdown rather than always showing the official builds. */
          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
              {selectedKey === 'official'
                ? 'Available llama.cpp builds'
                : selectedFork
                  ? `${selectedFork.name} · build`
                  : 'Available builds'}
            </p>
            {selectedKey === 'official' ? (
              <LlamaCppBackendRows />
            ) : selectedKey === 'mlx' ? (
              <MlxEngineRow />
            ) : selectedFork ? (
              <EngineRow engine={selectedFork} />
            ) : (
              <LlamaCppBackendRows />
            )}
          </div>
        )}

        {/* Discover engines (ADR-044): install additional engine kinds (vLLM, MLX,
            TurboQuant) beyond the default llama.cpp builds. */}
        <DiscoverEngines />

        {/* Live engine log */}
        {activeEngine && <EngineLogPanel open={logPanelOpen} onOpenChange={setLogPanelOpen} />}
      </div>
    </div>
  )
}
