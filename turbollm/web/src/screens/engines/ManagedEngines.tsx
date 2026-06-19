import { useState } from 'react'
import { Check, Download, ExternalLink, Loader2, MoreHorizontal, Sparkles } from 'lucide-react'
import { useBackendInstall, useEngineBackends, useEngineCatalog, useEngines, useEngineMutations, useStatus } from '../../lib/queries'
import { ApiError } from '../../lib/api'
import type { CatalogEngine } from '../../lib/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../../components/ui/alert-dialog'

const SIZE_HINT: Record<string, string> = {
  cuda: '~550 MB', rocm: '~320 MB', sycl: '~110 MB', vulkan: '~40 MB', metal: '~11 MB', cpu: '~16 MB',
}

/** One flat row per official llama.cpp backend variant. 3-state lifecycle:
 *  Not installed → Download button.
 *  Installed + enabled → "Installed" indicator + ⋯ menu (Update / Disable / Delete).
 *  Installed + disabled → "Disabled" badge + ⋯ menu (Update / Enable / Delete). */
export function LlamaCppBackendRows() {
  const { data: status } = useStatus()
  const provisioning = !!status?.engineProvision?.active
  const { data, isLoading } = useEngineBackends(provisioning)
  const install = useBackendInstall()
  // For Disable: unregister the engine entry only (keep files). Uses registry engine id.
  const engineMutForDisable = useEngineMutations()
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null)

  if (isLoading || !data) return null

  const anyPending = provisioning || install.backend.isPending || install.remove.isPending ||
    install.enableBackend.isPending || install.updateBackend.isPending ||
    engineMutForDisable.remove.isPending

  const gpu = data.gpus[0]?.name

  const download = (id: string) =>
    install.backend.mutate(id, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not download backend.'),
    })

  const doEnable = (id: string) =>
    install.enableBackend.mutate(id, {
      onSuccess: () => toast.success('Backend enabled'),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not enable backend.'),
    })

  // Disable = unregister from registry only (keep files on disk).
  // engineId is the registry entry id; remove() unregisters without touching disk.
  const doDisable = (engineId: string, label: string) =>
    engineMutForDisable.remove.mutate(engineId, {
      onSuccess: () => toast.success(`${label} disabled`),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not disable backend.'),
    })

  // Update: the daemon reports 'already latest' when the pinned build is present (no download),
  // otherwise it provisions the newer build (progress shows via the engineProvision channel).
  const doUpdate = (id: string) =>
    install.updateBackend.mutate(id, {
      onSuccess: (res) =>
        res?.alreadyLatest
          ? toast.success(`You're on the latest build${res.build ? ` (${res.build})` : ''}`)
          : toast.success('Downloading the latest build…'),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not update backend.'),
    })

  // Delete = remove files from disk via the backend delete endpoint. backend id (e.g. 'cuda').
  const doDelete = (id: string) =>
    install.remove.mutate(id, {
      onSuccess: () => {
        toast.success(`${deleteTarget?.label ?? 'Backend'} deleted`)
        setDeleteTarget(null)
      },
      onError: (e) => {
        setDeleteTarget(null)
        toast.error(e instanceof ApiError ? e.message : 'Could not delete backend.')
      },
    })

  return (
    <>
      {data.backends.map((b) => (
        <div
          key={b.id}
          className="flex items-center gap-3 rounded-[var(--radius)] border border-border bg-panel p-4"
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold text-ink">{b.label}</span>
              <Badge variant="default">official</Badge>
              {b.recommended && (
                <span className="flex items-center gap-0.5 text-[11px] text-accent">
                  <Sparkles size={10} /> recommended
                </span>
              )}
              {b.installed && !b.enabled && (
                <Badge variant="mono">Disabled</Badge>
              )}
            </div>
            <div className="mt-0.5 text-[12px] text-muted">
              {b.installed
                ? `Installed · ${gpu ?? 'GPU detected'}`
                : `Not installed · ${SIZE_HINT[b.id] ?? 'download to use'}`}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!b.installed ? (
              <Button size="sm" variant="outline" disabled={anyPending} onClick={() => download(b.id)}>
                {provisioning ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Download size={13} />
                )}
                Download
              </Button>
            ) : (
              <>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={`Actions for ${b.label}`}
                    disabled={anyPending}
                    className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-50"
                  >
                    <MoreHorizontal size={16} />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => doUpdate(b.id)} disabled={provisioning}>
                      <Download size={14} /> Update
                    </DropdownMenuItem>
                    {b.enabled ? (
                      <DropdownMenuItem onSelect={() => b.engineId && doDisable(b.engineId, b.label)}>
                        Disable
                      </DropdownMenuItem>
                    ) : (
                      <DropdownMenuItem onSelect={() => doEnable(b.id)}>
                        Enable
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      destructive
                      onSelect={() => setDeleteTarget({ id: b.id, label: b.label })}
                    >
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </div>
      ))}

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Files for this engine are removed from disk. Your models are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && doDelete(deleteTarget.id)}
              disabled={install.remove.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/**
 * Discover engines (ADR-044): the browsable catalog of installable engine kinds
 * beyond the default llama.cpp builds — vLLM, MLX, TurboQuant.
 *
 * 3-state lifecycle per row:
 *  Not installed → Install button.
 *  Installed + enabled → "Installed" indicator + ⋯ menu (Update / Disable / Delete).
 *  Installed + disabled → "Disabled" badge + ⋯ menu (Update / Enable / Delete).
 */
export function DiscoverEngines() {
  const { data: status } = useStatus()
  const provisioning = !!status?.engineProvision?.active
  const { data, isLoading } = useEngineCatalog(provisioning)
  const { data: registry } = useEngines()
  const install = useBackendInstall()
  const engineMut = useEngineMutations()
  const [deleteTarget, setDeleteTarget] = useState<{ e: CatalogEngine; registryId: string } | null>(null)

  if (isLoading || !data) return null

  // Prefilter by OS (ADR-044): only engines that can run on this platform are
  // offered. llama.cpp (the default) is managed via the Active Engine selector +
  // its backend builds, so the catalog card lists the additional engine kinds only.
  const engines = data.engines.filter((e) => e.id !== 'llama.cpp' && e.supportedHere)
  if (engines.length === 0) return null

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

  // Map a catalog entry to its install mutation by install endpoint.
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

  // Find the registered engine this catalog entry installed, so it can be disabled/deleted.
  // Mirrors the daemon's catalog `enabled` detection: pip engines register under their own
  // kind; TurboQuant is a llama-server fork detected by its install dir.
  const registryEngineId = (e: CatalogEngine): string | undefined => {
    const list = registry?.engines ?? []
    if (e.provision === 'pip') return list.find((x) => x.kind === e.kind)?.id
    if (e.id === 'turboquant') return list.find((x) => /[\\/]engines[\\/]turboquant[\\/]/.test(x.binPath))?.id
    return undefined
  }

  const doInstall = (e: CatalogEngine) => {
    const m = installFor(e)
    if (!m) return
    m.mutate(undefined, {
      onError: (err) =>
        toast.error(err instanceof ApiError ? err.message : `Could not install ${e.name}.`),
    })
  }

  // Disable = unregister from registry (keep files on disk). Uses the registry engine id.
  const doDisable = (e: CatalogEngine) => {
    const id = registryEngineId(e)
    if (!id) { toast.error(`Could not find the installed ${e.name} engine.`); return }
    engineMut.remove.mutate(id, {
      onSuccess: () => toast.success(`${e.name} disabled`),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not disable ${e.name}.`),
    })
  }

  // Enable = re-run install endpoint; idempotent when files already exist (fast no-op).
  const doEnable = (e: CatalogEngine) => {
    const m = installFor(e)
    if (!m) return
    m.mutate(undefined, {
      onSuccess: () => toast.success(`${e.name} enabled`),
      onError: (err) =>
        toast.error(err instanceof ApiError ? err.message : `Could not enable ${e.name}.`),
    })
  }

  const doUpdate = (e: CatalogEngine) => {
    const m = updateFor(e)
    if (!m) return
    m.mutate(undefined, {
      onSuccess: () => toast.success(`Updating ${e.name} to the latest release…`),
      onError: (err) =>
        toast.error(err instanceof ApiError ? err.message : `Could not update ${e.name}.`),
    })
  }

  // Delete = unregister + purge files from disk. Confirm first.
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
      <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Discover engines</p>
      {engines.map((e) => {
        const m = installFor(e)
        const canInstall = e.supportedHere && !e.comingSoon && !e.installed && !!m
        const thisPending = !!m?.isPending
        // 3-state: installed = files on disk; enabled = registered in registry.
        const isInstalled = !!e.installed
        const isEnabled = !!e.enabled
        const isDisabled = isInstalled && !isEnabled

        return (
          <div
            key={e.id}
            className="flex items-start gap-3 rounded-[var(--radius)] border border-border bg-panel p-4"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-semibold text-ink">{e.name}</span>
                {e.support === 'experimental' && !e.comingSoon && (
                  <Badge variant="mono">experimental</Badge>
                )}
                {e.comingSoon && <Badge variant="mono">coming soon</Badge>}
                {isDisabled && <Badge variant="mono">Disabled</Badge>}
                {!e.supportedHere && !e.comingSoon && (
                  <span className="text-[11px] text-faint">not available on this OS</span>
                )}
                <a
                  href={e.homepage}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-0.5 text-[11px] text-muted hover:text-ink"
                  title={e.homepage}
                >
                  <ExternalLink size={10} /> docs
                </a>
              </div>
              <div className="mt-0.5 text-[12px] text-muted">{e.description}</div>
              {e.note && <div className="mt-1 text-[11px] text-faint">{e.note}</div>}
            </div>
            <div className="flex shrink-0 items-center gap-2 pt-0.5">
              {isInstalled ? (
                <>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={`Actions for ${e.name}`}
                      disabled={anyPending}
                      className="grid h-8 w-8 place-items-center rounded-md text-muted hover:bg-panel-2 hover:text-ink disabled:opacity-50"
                    >
                      <MoreHorizontal size={16} />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => doUpdate(e)} disabled={provisioning}>
                        <Download size={14} /> Update
                      </DropdownMenuItem>
                      {isEnabled ? (
                        <DropdownMenuItem onSelect={() => doDisable(e)}>
                          Disable
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onSelect={() => doEnable(e)}>
                          Enable
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuSeparator />
                      <DropdownMenuItem destructive onSelect={() => requestDelete(e)}>
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canInstall || anyPending}
                  onClick={() => doInstall(e)}
                  title={
                    e.comingSoon
                      ? 'Not yet available'
                      : !e.supportedHere
                        ? 'Not supported on this operating system'
                        : `Install ${e.name}`
                  }
                >
                  {thisPending ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
                  {e.comingSoon ? 'Coming soon' : 'Install'}
                </Button>
              )}
            </div>
          </div>
        )
      })}

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

/** MLX engine row (macOS / Apple Silicon only). Shows Install action only when not installed;
 *  use the Active Engine dropdown at the top to select it once installed. */
export function MlxEngineRow() {
  const { data: status } = useStatus()
  const provisioning = !!status?.engineProvision?.active
  const { data } = useEngineBackends(provisioning)
  const install = useBackendInstall()

  if (!data?.mlx.supported) return null

  const mlx = data.mlx
  const busy = provisioning || install.mlx.isPending

  return (
    <div className="flex items-center gap-3 rounded-[var(--radius)] border border-border bg-panel p-4">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-ink">MLX</span>
          <Badge variant="default">Apple Silicon</Badge>
        </div>
        <div className="mt-0.5 text-[12px] text-muted">
          {mlx.installed
            ? 'Installed · Apple Metal'
            : 'Apple-native inference · installs mlx-lm via uv'}
        </div>
      </div>
      {!mlx.installed ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            install.mlx.mutate(undefined, {
              onError: (e) =>
                toast.error(e instanceof ApiError ? e.message : 'Could not install MLX.'),
            })
          }
        >
          {busy && install.mlx.isPending ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Download size={13} />
          )}
          Install
        </Button>
      ) : (
        <span className="flex items-center gap-1 text-[12px] font-medium text-accent">
          <Check size={13} /> Installed
        </span>
      )}
    </div>
  )
}
