import { useState } from 'react'
import { Download, Loader2, MoreHorizontal, Sparkles } from 'lucide-react'
import { useBackendInstall, useEngineBackends, useEngineMutations, useStatus } from '../../lib/queries'
import { ApiError } from '../../lib/api'
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
