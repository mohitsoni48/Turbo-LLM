import { useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  Cpu,
  Download,
  ExternalLink,
  Layers,
  Loader2,
  MoreHorizontal,
  Settings2,
  Sparkles,
} from 'lucide-react'
import {
  useBackendInstall,
  useEngineBackends,
  useEngineCatalog,
  useEngineMutations,
  useEngineRecommendation,
  useEngines,
  useStatus,
  useSysInfo,
} from '../lib/queries'
import { ApiError } from '../lib/api'
import type {
  CatalogEngine,
  Engine,
  EngineBackends,
  EngineFit,
  EngineRecommendationResult,
  EnginesList,
} from '../lib/types'
import { useUiStore } from '../stores/ui'
import { ScreenHeader, InlineError } from '../components/common'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Skeleton } from '../components/ui/skeleton'
import { toast } from '../components/ui/sonner'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../components/ui/collapsible'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../components/ui/alert-dialog'
import { AddEngineDialog } from './engines/AddEngineDialog'
import { EngineStatusHeader } from './engines/EngineStatusHeader'
import { EngineLogPanel } from './engines/EngineLogPanel'
import { LlamaCppBackendRows } from './engines/ManagedEngines'

const ISSUE_URL = 'https://github.com/mohitsoni48/Turbo-LLM/issues/new'

/** Auto-downloaded official llama.cpp builds live in
 *  `<config>/engines/llama.cpp-<tag>-<backend>/`; everything else is a user fork. */
const isOfficialLlama = (binPath: string) => /[\\/]engines[\\/]llama\.cpp-/.test(binPath)

/** Map a registered engine to its catalog id ('llama.cpp' | 'turboquant' | 'mlx' | 'vllm').
 *  Used to line a running engine up against the recommendation (catalog ids). */
function catalogIdFor(e: Engine): string {
  if (e.kind === 'mlx') return 'mlx'
  if (e.kind === 'vllm') return 'vllm'
  if (/[\\/]engines[\\/]turboquant[\\/]/.test(e.binPath)) return 'turboquant'
  return 'llama.cpp'
}

/** Human build label for a running engine, e.g. "llama.cpp · CUDA". Derives the GPU
 *  backend from the registered name for official builds; falls back to the kind. */
function buildContextFor(e: Engine, backends: EngineBackends | undefined): string {
  if (e.kind === 'mlx') return 'MLX · Apple Metal'
  if (e.kind === 'vllm') return 'vLLM'
  if (isOfficialLlama(e.binPath)) {
    // The active official backend (cuda/metal/…) carries a friendly label.
    const active = backends?.backends.find((b) => b.active)
    return active ? `llama.cpp · ${active.label}` : 'llama.cpp'
  }
  return e.name
}

/**
 * Engines screen (engine overhaul, Phase 2). Three calm zones:
 *  1. Status hero — detected hardware + a "Running now" engine dropdown.
 *  2. Install & manage — one unified catalog driven by the hardware recommendation.
 *  3. Advanced (collapsed) — the GPU build picker + official backend management.
 */
export function EnginesScreen() {
  const enginesQ = useEngines()
  const { data: status } = useStatus()
  const provisioning = !!status?.engineProvision?.active
  const recQ = useEngineRecommendation(provisioning)
  const backendsQ = useEngineBackends(provisioning)
  const logPanelOpen = useUiStore((s) => s.logPanelOpen)
  const setLogPanelOpen = useUiStore((s) => s.setLogPanelOpen)

  const list = enginesQ.data
  const activeId = list?.activeEngineId ?? ''
  const activeEngine = list?.engines.find((e) => e.id === activeId) ?? null

  return (
    <div className="w-full px-6 py-6">
      <ScreenHeader
        title="Engines"
        description="Switch the running engine up top. Install and manage engines below."
        actions={<AddEngineDialog />}
      />

      <div className="flex flex-col gap-5">
        {/* Zone 1 — Status hero */}
        <StatusHero
          rec={recQ.data}
          list={list}
          backends={backendsQ.data}
          activeEngine={activeEngine}
        />

        {/* Running-engine status + live log (kept below the hero). */}
        {activeEngine && (
          <EngineStatusHeader status={status} activeEngineName={activeEngine.name} />
        )}

        {/* Zone 2 — Unified install & manage catalog */}
        {enginesQ.isError ? (
          <InlineError
            message={enginesQ.error instanceof ApiError ? enginesQ.error.message : 'Could not load engines.'}
            onRetry={() => void enginesQ.refetch()}
          />
        ) : (
          <InstallManageCatalog
            rec={recQ.data}
            isLoading={recQ.isLoading}
            activeCatalogId={activeEngine ? catalogIdFor(activeEngine) : null}
          />
        )}

        {/* Zone 3 — Advanced */}
        <AdvancedSection list={list} backends={backendsQ.data} provisioning={provisioning} />

        {/* Live engine log */}
        {activeEngine && <EngineLogPanel open={logPanelOpen} onOpenChange={setLogPanelOpen} />}
      </div>
    </div>
  )
}

// ─── Zone 1 — Status hero ─────────────────────────────────────────────────────

function StatusHero({
  rec,
  list,
  backends,
  activeEngine,
}: {
  rec: EngineRecommendationResult | undefined
  list: EnginesList | undefined
  backends: EngineBackends | undefined
  activeEngine: Engine | null
}) {
  const mut = useEngineMutations()
  const { data: sys } = useSysInfo()

  // Hardware line — prefer the recommendation's hardware, fall back to sysinfo.
  const hw = rec?.hardware
  const gpuName = hw?.gpuName ?? sys?.gpus[0]?.name ?? null
  const vramMb = hw?.vramMb ?? sys?.gpus[0]?.vramMb ?? 0
  const osName = hw ? platformName(hw.platform) : sys?.os.split('/')[0] ? platformName(sys.os.split('/')[0]) : ''
  const hwLine = [
    gpuName ?? 'CPU-only',
    vramMb > 0 ? `${(vramMb / 1024).toFixed(0)} GB` : null,
    osName || null,
  ]
    .filter(Boolean)
    .join(' · ')

  // Installed engines = everything in the registry (each is a runnable engine).
  const installed = list?.engines ?? []
  const activeBuild = activeEngine ? buildContextFor(activeEngine, backends) : null

  // Does the running engine match the hardware recommendation?
  const recEngineId = rec?.recommendation.recommended?.engineId
  const activeMatchesRec =
    !!activeEngine && !!recEngineId && catalogIdFor(activeEngine) === recEngineId

  const busy = mut.activate.isPending

  const activate = (id: string) => {
    if (id === activeEngine?.id) return
    mut.activate.mutate(id, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not switch engine.'),
    })
  }

  return (
    <div
      className="rounded-lg border border-border bg-panel p-4"
      style={{ background: 'color-mix(in srgb, var(--ok) 5%, var(--panel))' }}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-muted">
            <Cpu size={13} className="shrink-0" style={{ color: 'var(--ok)' }} />
            Your hardware
          </div>
          <div className="mt-0.5 truncate text-sm font-semibold text-ink">{hwLine || 'Detecting…'}</div>
        </div>

        <div className="flex flex-col items-start gap-1 md:items-end">
          <span className="text-[11px] font-medium uppercase tracking-wide text-faint">Running now</span>
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={busy || installed.length === 0}
              className="flex h-9 min-w-[220px] items-center gap-2 rounded-lg border border-border bg-bg px-3 text-[13px] text-ink transition-colors hover:border-[color:var(--accent)] disabled:opacity-60"
            >
              <span className="flex h-2 w-2 shrink-0 rounded-full" style={{ background: activeEngine ? 'var(--ok)' : 'var(--faint)' }} />
              <span className="flex-1 truncate text-left">
                {activeEngine?.name ?? (installed.length ? 'No engine active' : 'No engine installed')}
              </span>
              <ChevronDown size={14} className="shrink-0 text-muted" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-[280px]">
              <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
                Installed engines
              </div>
              {installed.length === 0 && (
                <div className="px-2 py-1.5 text-[12px] text-muted">Install an engine below to get started.</div>
              )}
              {installed.map((e) => (
                <DropdownMenuItem key={e.id} onSelect={() => activate(e.id)} className="flex items-center gap-2">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {e.id === activeEngine?.id && <Check size={14} className="text-accent" />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ink">{e.name}</span>
                  {e.id === activeEngine?.id && (
                    <span className="shrink-0 text-[11px] text-accent">active</span>
                  )}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 text-[11px] text-faint">Install more engines below ↓</div>
            </DropdownMenuContent>
          </DropdownMenu>

          {activeBuild && <span className="text-[11px] text-muted">{activeBuild}</span>}
          {activeMatchesRec && (
            <span className="flex items-center gap-1 text-[11px]" style={{ color: 'var(--ok)' }}>
              <Sparkles size={11} /> recommended for your hardware
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Zone 2 — Unified install & manage catalog ────────────────────────────────

function InstallManageCatalog({
  rec,
  isLoading,
  activeCatalogId,
}: {
  rec: EngineRecommendationResult | undefined
  isLoading: boolean
  activeCatalogId: string | null
}) {
  const { data: status } = useStatus()
  const provisioning = !!status?.engineProvision?.active
  const catalogQ = useEngineCatalog(provisioning)
  const { data: registry } = useEngines()
  const install = useBackendInstall()
  const engineMut = useEngineMutations()
  const [deleteTarget, setDeleteTarget] = useState<{ e: CatalogEngine; registryId: string } | null>(null)

  // Disk/registry install state lives in the catalog endpoint; the fit/badge
  // ordering lives in the recommendation. Join them by id.
  const catalogById = useMemo(() => {
    const m = new Map<string, CatalogEngine>()
    for (const e of catalogQ.data?.engines ?? []) m.set(e.id, e)
    return m
  }, [catalogQ.data])

  if (isLoading || !rec) {
    return (
      <section className="flex flex-col gap-2">
        <SectionLabel>Install &amp; manage</SectionLabel>
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </section>
    )
  }

  const anyPending =
    provisioning ||
    install.vllm.isPending ||
    install.mlx.isPending ||
    install.turboquant.isPending ||
    install.updateVllm.isPending ||
    install.updateMlx.isPending ||
    install.updateTurboquant.isPending ||
    engineMut.remove.isPending ||
    engineMut.purge.isPending

  // ── lifecycle (mirrors ManagedEngines.DiscoverEngines) ──
  const installFor = (e: CatalogEngine) => {
    if (e.installEndpoint === '/api/v1/engines/vllm') return install.vllm
    if (e.installEndpoint === '/api/v1/engines/mlx') return install.mlx
    if (e.installEndpoint === '/api/v1/engines/turboquant') return install.turboquant
    return null
  }
  const updateFor = (e: CatalogEngine) => {
    if (e.installEndpoint === '/api/v1/engines/vllm') return install.updateVllm
    if (e.installEndpoint === '/api/v1/engines/mlx') return install.updateMlx
    if (e.installEndpoint === '/api/v1/engines/turboquant') return install.updateTurboquant
    return null
  }
  const registryEngineId = (e: CatalogEngine): string | undefined => {
    const eng = registry?.engines ?? []
    if (e.provision === 'pip') return eng.find((x) => x.kind === e.kind)?.id
    if (e.id === 'turboquant') return eng.find((x) => /[\\/]engines[\\/]turboquant[\\/]/.test(x.binPath))?.id
    return undefined
  }
  const doInstall = (e: CatalogEngine) => {
    const m = installFor(e)
    if (!m) return
    m.mutate(undefined, {
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not install ${e.name}.`),
    })
  }
  const doEnable = (e: CatalogEngine) => {
    const m = installFor(e)
    if (!m) return
    m.mutate(undefined, {
      onSuccess: () => toast.success(`${e.name} enabled`),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not enable ${e.name}.`),
    })
  }
  const doDisable = (e: CatalogEngine) => {
    const id = registryEngineId(e)
    if (!id) { toast.error(`Could not find the installed ${e.name} engine.`); return }
    engineMut.remove.mutate(id, {
      onSuccess: () => toast.success(`${e.name} disabled`),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not disable ${e.name}.`),
    })
  }
  const doUpdate = (e: CatalogEngine) => {
    const m = updateFor(e)
    if (!m) return
    m.mutate(undefined, {
      onSuccess: () => toast.success(`Updating ${e.name} to the latest release…`),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not update ${e.name}.`),
    })
  }
  const requestDelete = (e: CatalogEngine) => {
    const registryId = registryEngineId(e)
    if (!registryId) { toast.error(`Could not find the installed ${e.name} engine to delete.`); return }
    setDeleteTarget({ e, registryId })
  }
  const doDelete = () => {
    if (!deleteTarget) return
    engineMut.purge.mutate(deleteTarget.registryId, {
      onSuccess: () => {
        toast.success(`${deleteTarget.e.name} deleted`)
        setDeleteTarget(null)
      },
      onError: (err) => {
        setDeleteTarget(null)
        toast.error(err instanceof ApiError ? err.message : `Could not delete ${deleteTarget.e.name}.`)
      },
    })
  }

  return (
    <section className="flex flex-col gap-2">
      <SectionLabel>Install &amp; manage</SectionLabel>

      {rec.recommendation.fits.map((fit) => (
        <CatalogFitRow
          key={fit.engine.id}
          fit={fit}
          catalog={catalogById.get(fit.engine.id)}
          isActive={activeCatalogId === fit.engine.id}
          anyPending={anyPending}
          provisioning={provisioning}
          installFor={installFor}
          onInstall={doInstall}
          onEnable={doEnable}
          onDisable={doDisable}
          onUpdate={doUpdate}
          onDelete={requestDelete}
        />
      ))}

      {/* Add your own engine — first-class item in this zone. */}
      <div className="flex items-center gap-3 rounded-[var(--radius)] border border-dashed border-border-strong bg-panel p-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-ink">Add your own engine</div>
          <div className="mt-0.5 text-[12px] text-muted">
            Point TurboLLM at any llama-server compatible binary — mainline llama.cpp or a community fork.
          </div>
        </div>
        <div className="shrink-0">
          <AddEngineDialog />
        </div>
      </div>

      {/* Quiet "register it" link at the very bottom. */}
      <a
        href={ISSUE_URL}
        target="_blank"
        rel="noreferrer"
        className="mt-1 inline-flex items-center gap-1 self-start text-[12px] text-muted hover:text-ink"
      >
        Don&apos;t see your engine? Register it <ExternalLink size={11} />
      </a>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.e.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Files for this engine are removed from disk. Your models are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={doDelete} disabled={engineMut.purge.isPending}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

/** One unified catalog row driven by the engine fit + its catalog install state. */
function CatalogFitRow({
  fit,
  catalog,
  isActive,
  anyPending,
  provisioning,
  installFor,
  onInstall,
  onEnable,
  onDisable,
  onUpdate,
  onDelete,
}: {
  fit: EngineFit
  catalog: CatalogEngine | undefined
  isActive: boolean
  anyPending: boolean
  provisioning: boolean
  installFor: (e: CatalogEngine) => { isPending: boolean } | null
  onInstall: (e: CatalogEngine) => void
  onEnable: (e: CatalogEngine) => void
  onDisable: (e: CatalogEngine) => void
  onUpdate: (e: CatalogEngine) => void
  onDelete: (e: CatalogEngine) => void
}) {
  const e = fit.engine
  const isLlama = e.id === 'llama.cpp'
  const incompatible = fit.compatible.length === 0
  const experimental = e.support === 'experimental'
  const isInstalled = !!catalog?.installed
  const isEnabled = !!catalog?.enabled
  const isDisabled = isInstalled && !isEnabled

  return (
    <div
      className="flex items-start gap-3 rounded-[var(--radius)] border border-border bg-panel p-4"
      style={incompatible ? { opacity: 0.65 } : undefined}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-semibold text-ink">{e.name}</span>

          {/* Fit badge: recommended → accent; active → Active (--ok); else Installed. */}
          {fit.recommended ? (
            <Badge variant="accent">
              <Sparkles size={10} /> Recommended for you
            </Badge>
          ) : isActive ? (
            <span className="flex items-center gap-1 text-[11px] font-medium" style={{ color: 'var(--ok)' }}>
              <Check size={11} /> Active
            </span>
          ) : isEnabled ? (
            <span className="flex items-center gap-1 text-[11px] font-medium text-muted">
              <Check size={11} /> Installed
            </span>
          ) : null}

          {experimental && <Badge variant="mono">experimental</Badge>}
          {e.id === 'vllm' && <Badge variant="mono">For power users</Badge>}
          {isDisabled && <Badge variant="mono">Disabled</Badge>}
          {incompatible && fit.incompatibleReason && (
            <Badge variant="mono">{fit.incompatibleReason}</Badge>
          )}

          {catalog && (
            <a
              href={catalog.homepage}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-0.5 text-[11px] text-muted hover:text-ink"
              title={catalog.homepage}
            >
              <ExternalLink size={10} /> docs
            </a>
          )}
        </div>

        <div className="mt-0.5 text-[12px] text-muted">{e.description}</div>
        {isLlama && (
          <div className="mt-1 text-[11px] text-faint">
            Pick a specific GPU build in Advanced below.
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2 pt-0.5">
        {isLlama ? (
          // llama.cpp is the built-in default — its builds are managed in Zone 3.
          <span className="text-[12px] text-faint">built-in</span>
        ) : !catalog ? null : isInstalled ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Actions for ${e.name}`}
              disabled={anyPending}
              className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-50"
            >
              <MoreHorizontal size={16} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onUpdate(catalog)} disabled={provisioning}>
                <Download size={14} /> Update
              </DropdownMenuItem>
              {isEnabled ? (
                <DropdownMenuItem onSelect={() => onDisable(catalog)}>Disable</DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => onEnable(catalog)}>Enable</DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem destructive onSelect={() => onDelete(catalog)}>
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button
            size="sm"
            variant="outline"
            disabled={anyPending || incompatible || catalog.comingSoon || !installFor(catalog)}
            onClick={() => onInstall(catalog)}
            title={
              catalog.comingSoon
                ? 'Not yet available'
                : incompatible
                  ? fit.incompatibleReason ?? 'Not supported on this hardware'
                  : `Install ${e.name}`
            }
          >
            {installFor(catalog)?.isPending ? (
              <Loader2 size={13} className="animate-spin" />
            ) : (
              <Download size={13} />
            )}
            {catalog.comingSoon ? 'Coming soon' : 'Install'}
          </Button>
        )}
      </div>
    </div>
  )
}

// ─── Zone 3 — Advanced ────────────────────────────────────────────────────────

function AdvancedSection({
  list,
  backends,
  provisioning,
}: {
  list: EnginesList | undefined
  backends: EngineBackends | undefined
  provisioning: boolean
}) {
  const [open, setOpen] = useState(false)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border bg-panel-2">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <Settings2 size={15} className="shrink-0 text-muted" />
        <span className="flex-1 text-[13px] font-medium text-ink">
          Advanced — pick a specific GPU build · manage installed backends
        </span>
        <ChevronDown size={15} className={`shrink-0 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-3 border-t border-border px-4 py-4">
          <div>
            <div className="mb-2 text-[12px] text-muted">
              The GPU build is the only place you choose llama.cpp&apos;s compiled backend (CUDA, Vulkan, Metal, CPU).
            </div>
            <BuildPicker list={list} backends={backends} provisioning={provisioning} />
          </div>
          <div className="flex flex-col gap-2">
            <SectionLabel>Installed llama.cpp builds</SectionLabel>
            <LlamaCppBackendRows />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

/** GPU build dropdown for official llama.cpp (the Build-dropdown behavior lifted out
 *  of the old EngineSelector). Selecting an installed build activates it; selecting an
 *  uninstalled build downloads (then activates) it. */
function BuildPicker({
  list,
  backends,
  provisioning,
}: {
  list: EnginesList | undefined
  backends: EngineBackends | undefined
  provisioning: boolean
}) {
  const mut = useEngineMutations()
  const install = useBackendInstall()

  if (!list || !backends) return null

  const busy = provisioning || mut.activate.isPending || install.backend.isPending
  const activeBuild = backends.backends.find((b) => b.active)

  const selectBuild = (b: EngineBackends['backends'][number]) => {
    if (b.active) return
    if (b.installed && b.engineId) {
      mut.activate.mutate(b.engineId, {
        onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not switch build.'),
      })
    } else {
      install.backend.mutate(b.id, {
        onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not download build.'),
      })
    }
  }

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-faint">Build (GPU backend)</span>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={busy}
          className="flex h-9 min-w-[220px] items-center gap-2 rounded-lg border border-border bg-bg px-3 text-[13px] text-ink transition-colors hover:border-[color:var(--accent)] disabled:opacity-60"
        >
          <Layers size={15} className="text-accent" />
          <span className="flex-1 truncate text-left">{activeBuild?.label ?? 'Choose a build'}</span>
          <ChevronDown size={14} className="shrink-0 text-muted" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[260px]">
          <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
            Build — which GPU backend
          </div>
          {backends.backends.map((b) => (
            <DropdownMenuItem key={b.id} onSelect={() => selectBuild(b)} className="flex items-center gap-2">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                {b.active && <Check size={14} className="text-accent" />}
              </span>
              <span className="min-w-0 flex-1 truncate text-ink">{b.label}</span>
              {b.recommended && (
                <Sparkles size={11} className="shrink-0 text-accent" aria-label="recommended" />
              )}
              <span className="shrink-0 text-[11px] text-muted">
                {b.active ? 'active' : b.installed ? 'installed' : 'download'}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </label>
  )
}

// ─── shared helpers ───────────────────────────────────────────────────────────

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-medium uppercase tracking-wide text-faint">{children}</p>
}

const PLATFORM_DISPLAY: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}
function platformName(p: string): string {
  return PLATFORM_DISPLAY[p] ?? p
}
