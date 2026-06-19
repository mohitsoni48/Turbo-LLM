import { Check, Download, ExternalLink, Loader2, Sparkles, Trash2 } from 'lucide-react'
import { useBackendInstall, useEngineBackends, useEngineCatalog, useEngines, useEngineMutations, useStatus } from '../../lib/queries'
import { ApiError } from '../../lib/api'
import type { CatalogEngine } from '../../lib/types'
import { Badge } from '../../components/ui/badge'
import { Button } from '../../components/ui/button'
import { toast } from '../../components/ui/sonner'

const SIZE_HINT: Record<string, string> = {
  cuda: '~550 MB', rocm: '~320 MB', sycl: '~110 MB', vulkan: '~40 MB', metal: '~11 MB', cpu: '~16 MB',
}

/** One flat row per official llama.cpp backend variant. Management only (download / delete).
 *  Engine selection is exclusively via the Active Engine dropdown at the top of the page. */
export function LlamaCppBackendRows() {
  const { data: status } = useStatus()
  const provisioning = !!status?.engineProvision?.active
  const { data, isLoading } = useEngineBackends(provisioning)
  const install = useBackendInstall()

  if (isLoading || !data) return null

  const busy = provisioning || install.backend.isPending || install.remove.isPending
  const gpu = data.gpus[0]?.name

  const download = (id: string) =>
    install.backend.mutate(id, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not download backend.'),
    })

  const del = (id: string, label: string) =>
    install.remove.mutate(id, {
      onSuccess: () => toast.success(`${label} removed`),
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not delete backend.'),
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
            </div>
            <div className="mt-0.5 text-[12px] text-muted">
              {b.installed
                ? `Installed · ${gpu ?? 'GPU detected'}`
                : `Not installed · ${SIZE_HINT[b.id] ?? 'download to use'}`}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {!b.installed ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => download(b.id)}>
                {provisioning ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Download size={13} />
                )}
                Download
              </Button>
            ) : (
              <>
                <span className="flex items-center gap-1 text-[12px] font-medium text-accent">
                  <Check size={13} /> Installed
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => del(b.id, b.label)}
                  title={`Delete ${b.label}`}
                  className="grid h-8 w-8 place-items-center rounded border border-border text-faint transition-colors hover:border-[color:var(--err)] hover:text-[color:var(--err)] disabled:opacity-50"
                >
                  <Trash2 size={14} />
                </button>
              </>
            )}
          </div>
        </div>
      ))}
    </>
  )
}

/**
 * Discover engines (ADR-044): the browsable catalog of installable engine kinds
 * beyond the default llama.cpp builds — vLLM, MLX, TurboQuant. The llama.cpp
 * default + its GPU backends are managed by the Active Engine selector above;
 * this card is where new engine *kinds* are installed. Once installed, an engine
 * becomes selectable as the active engine from the dropdown at the top.
 */
export function DiscoverEngines() {
  const { data: status } = useStatus()
  const provisioning = !!status?.engineProvision?.active
  const { data, isLoading } = useEngineCatalog(provisioning)
  const { data: registry } = useEngines()
  const install = useBackendInstall()
  const engineMut = useEngineMutations()

  if (isLoading || !data) return null

  // Prefilter by OS (ADR-044): only engines that can run on this platform are
  // offered. llama.cpp (the default) is managed via the Active Engine selector +
  // its backend builds, so the catalog card lists the additional engine kinds only.
  const engines = data.engines.filter((e) => e.id !== 'llama.cpp' && e.supportedHere)
  if (engines.length === 0) return null

  const busy =
    provisioning ||
    install.vllm.isPending ||
    install.mlx.isPending ||
    install.turboquant.isPending ||
    engineMut.remove.isPending

  // Map a catalog entry to its install mutation by install endpoint.
  const installFor = (e: CatalogEngine) => {
    if (e.installEndpoint === '/api/v1/engines/vllm') return install.vllm
    if (e.installEndpoint === '/api/v1/engines/mlx') return install.mlx
    if (e.installEndpoint === '/api/v1/engines/turboquant') return install.turboquant
    return null
  }

  // Find the registered engine this catalog entry installed, so it can be removed.
  // Mirrors the daemon's catalog `installed` detection: pip engines register under
  // their own kind; TurboQuant is a llama-server fork detected by its install dir.
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

  const doRemove = (e: CatalogEngine) => {
    const id = registryEngineId(e)
    if (!id) {
      toast.error(`Could not find the installed ${e.name} engine to remove.`)
      return
    }
    engineMut.remove.mutate(id, {
      onSuccess: () => toast.success(`${e.name} removed`),
      onError: (err) => toast.error(err instanceof ApiError ? err.message : `Could not remove ${e.name}.`),
    })
  }

  return (
    <section className="flex flex-col gap-2">
      <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Discover engines</p>
      {engines.map((e) => {
        const m = installFor(e)
        const canInstall = e.supportedHere && !e.comingSoon && !e.installed && !!m
        const thisPending = !!m?.isPending
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
              {e.installed ? (
                <>
                  <span className="flex items-center gap-1 text-[12px] font-medium text-accent">
                    <Check size={13} /> Installed
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => doRemove(e)}
                    title={`Remove ${e.name}`}
                    className="grid h-8 w-8 place-items-center rounded border border-border text-faint transition-colors hover:border-[color:var(--err)] hover:text-[color:var(--err)] disabled:opacity-50"
                  >
                    <Trash2 size={14} />
                  </button>
                </>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canInstall || busy}
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
