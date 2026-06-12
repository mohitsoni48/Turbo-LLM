import { Check, Cpu, Download, Loader2, Sparkles } from 'lucide-react'
import { useEngineBackends, useBackendInstall } from '../../lib/queries'
import { useStatus } from '../../lib/queries'
import { Button } from '../../components/ui/button'
import { Badge } from '../../components/ui/badge'
import { toast } from '../../components/ui/sonner'
import { ApiError } from '../../lib/api'

// Rough download sizes for the UI hint (MB). Backends not listed fall back to ~40MB.
const SIZE_HINT: Record<string, string> = {
  cuda: '~550 MB',
  rocm: '~320 MB',
  sycl: '~110 MB',
  vulkan: '~40 MB',
  metal: '~11 MB',
  cpu: '~16 MB',
}

/** Hardware-aware backend selector (ADR-025): shows the detected GPU, the
 *  recommended backend, and lets the user switch (downloads on demand). */
export function BackendPicker() {
  const { data: status } = useStatus()
  const provisioning = !!status?.engineProvision?.active
  const { data, isLoading } = useEngineBackends(provisioning)
  const install = useBackendInstall()

  if (isLoading || !data) return null

  const gpuName = data.gpus[0]?.name
  const busy = provisioning || install.backend.isPending || install.mlx.isPending

  const onPick = (id: string) => {
    install.backend.mutate(id, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not switch backend.'),
    })
  }

  const onPickMlx = () => {
    install.mlx.mutate(undefined, {
      onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not install MLX.'),
    })
  }

  return (
    <div className="rounded-[var(--radius)] border border-border bg-panel p-4">
      <div className="mb-3 flex items-center gap-2">
        <Cpu size={15} className="text-muted" />
        <h3 className="text-sm font-semibold text-ink">Engine backend</h3>
        <span className="ml-auto text-[12px] text-muted">
          {gpuName ? `Detected: ${gpuName}` : 'No GPU detected — CPU only'}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        {data.backends.map((b) => {
          const size = SIZE_HINT[b.id] ?? '~40 MB'
          return (
            <div
              key={b.id}
              className="flex items-center gap-3 rounded-[var(--radius-sm)] border border-border px-3 py-2"
              style={b.active ? { borderColor: 'var(--accent)' } : undefined}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium text-ink">{b.label}</span>
                  {b.recommended && (
                    <Badge variant="mono" className="gap-1">
                      <Sparkles size={11} /> Recommended
                    </Badge>
                  )}
                  {b.active && (
                    <Badge variant="mono" className="gap-1" style={{ color: 'var(--accent)' }}>
                      <Check size={11} /> Active
                    </Badge>
                  )}
                </div>
                <span className="text-[11px] text-faint">
                  {b.installed ? 'Installed' : `Download ${size}`}
                </span>
              </div>

              {b.active ? (
                <Button size="sm" variant="ghost" disabled>
                  In use
                </Button>
              ) : b.installed ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => onPick(b.id)}>
                  Use
                </Button>
              ) : (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => onPick(b.id)}>
                  {busy && install.backend.variables === b.id ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Download size={13} />
                  )}
                  Download
                </Button>
              )}
            </div>
          )
        })}

        {/* MLX — a separate engine kind, macOS only (ADR-025 Phase 3) */}
        {data.mlx.supported && (
          <div
            className="flex items-center gap-3 rounded-[var(--radius-sm)] border border-border px-3 py-2"
            style={data.mlx.active ? { borderColor: 'var(--accent)' } : undefined}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-ink">MLX (Apple)</span>
                {data.mlx.active && (
                  <Badge variant="mono" className="gap-1" style={{ color: 'var(--accent)' }}>
                    <Check size={11} /> Active
                  </Badge>
                )}
              </div>
              <span className="text-[11px] text-faint">
                {data.mlx.installed ? 'Installed — loads MLX models' : 'Apple-native engine · installs mlx-lm via uv'}
              </span>
            </div>
            {data.mlx.active ? (
              <Button size="sm" variant="ghost" disabled>
                In use
              </Button>
            ) : (
              <Button size="sm" variant="outline" disabled={busy} onClick={onPickMlx}>
                {busy && install.mlx.isPending ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <Download size={13} />
                )}
                {data.mlx.installed ? 'Use' : 'Install'}
              </Button>
            )}
          </div>
        )}
      </div>

      <p className="mt-2.5 text-[11px] text-faint">
        Backends are official llama.cpp builds, downloaded on demand. Switching downloads the
        selected build and makes it active.
      </p>
    </div>
  )
}
