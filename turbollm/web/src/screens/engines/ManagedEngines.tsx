import { Check, Download, Loader2, Sparkles, Trash2 } from 'lucide-react'
import { useBackendInstall, useEngineBackends, useStatus } from '../../lib/queries'
import { ApiError } from '../../lib/api'
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
