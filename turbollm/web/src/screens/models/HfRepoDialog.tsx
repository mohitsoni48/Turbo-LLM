// HF repo detail dialog (spec 10 §3–4). Given a repo id, fetch the file list +
// gated/license metadata, present a single-select quant dropdown (each option:
// quant · size · fit dot · "Downloaded" tag), a live VRAM verdict line, and a
// primary action that is "Download" (enqueue) for a remote quant or "Load" for a
// quant already in the local library. Gated repos with no token show guidance and
// disable downloading.

import { useEffect, useMemo, useState } from 'react'
import { Download, ExternalLink, Lock, Zap } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { useDownloadMutations, useHfRepo, useModelActions, useStatus, useSysInfo } from '../../lib/queries'
import type { FitVerdict } from '../../lib/types'
import { Button } from '../../components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { toast } from '../../components/ui/sonner'

/** Per-quant VRAM fit estimate. We only know the file size here (no GGUF block/head
 *  metadata), so this is a coarse weights-plus-overhead heuristic vs total VRAM —
 *  deliberately conservative. Unknown VRAM → 'unknown' (neutral styling, spec 10 §3). */
function fileFit(sizeBytes: number, vramMb: number | undefined): FitVerdict {
  if (!vramMb) return 'unknown'
  const sizeMb = sizeBytes / 1e6
  // Reserve headroom for KV cache + runtime (~15% of file + 1GB baseline).
  const estMb = sizeMb * 1.15 + 1000
  const pct = estMb / vramMb
  if (pct <= 0.8) return 'fits'
  if (pct <= 0.95) return 'tight'
  return 'overflow'
}

const FIT_COLOR: Record<FitVerdict, string> = {
  fits: 'var(--ok)',
  tight: 'var(--warn)',
  overflow: 'var(--err)',
  cpu: 'var(--muted)',
  unknown: 'var(--faint)',
}

const FIT_LABEL: Record<FitVerdict, string> = {
  fits: 'Fits comfortably on your GPU.',
  tight: 'Tight fit — may slow under desktop load.',
  overflow: 'Larger than your VRAM — will spill to system RAM.',
  cpu: 'CPU-only — no GPU detected.',
  unknown: 'Fit unknown — GPU VRAM not detected.',
}

export function HfRepoDialog({
  repo,
  onClose,
  onSearch,
}: {
  repo: string | null
  onClose: () => void
  /** Fallback when the repo isn't found (e.g. an inferred id that doesn't match HF):
   *  switch to a Hugging Face search for the given term. */
  onSearch?: (term: string) => void
}) {
  const detailQ = useHfRepo(repo)
  const sysQ = useSysInfo()
  const dlMut = useDownloadMutations()
  const actions = useModelActions()

  const statusQ = useStatus()
  const engineKind = statusQ.data?.engine.kind ?? ''
  const detail = detailQ.data
  const vramMb = sysQ.data?.gpus?.[0]?.vramMb
  const isSafetensors = !!detail?.safetensors
  const [selected, setSelected] = useState<string>('')

  // Pre-select the recommended quant: largest that fits; prefer K-quants over IQ at
  // an equal size class (spec 10 §3). Re-runs when the file list changes.
  useEffect(() => {
    if (!detail) return
    const ggufs = detail.files.filter((f) => !f.mmproj)
    if (ggufs.length === 0) return
    const fits = ggufs.filter((f) => fileFit(f.sizeBytes, vramMb) === 'fits')
    const pool = fits.length > 0 ? fits : ggufs
    const best = [...pool].sort((a, b) => {
      if (b.sizeBytes !== a.sizeBytes) return b.sizeBytes - a.sizeBytes
      const aK = /q\d_k/i.test(a.quant) ? 0 : 1
      const bK = /q\d_k/i.test(b.quant) ? 0 : 1
      return aK - bK
    })[0]
    setSelected(best.name)
  }, [detail, vramMb])

  // Quant options sorted by size (smallest → largest) so the listing reads in a
  // sensible progression instead of alphabetically by filename.
  const ggufFiles = useMemo(
    () => (detail ? detail.files.filter((f) => !f.mmproj).sort((a, b) => a.sizeBytes - b.sizeBytes) : []),
    [detail],
  )
  const selectedFile = ggufFiles.find((f) => f.name === selected) ?? null
  const selectedIsLocal = !!selectedFile?.downloaded

  const fit = selectedFile ? fileFit(selectedFile.sizeBytes, vramMb) : 'unknown'
  const gated = detail?.gated ?? false
  // Gated repos require the user to accept the license + configure an HF token in
  // Settings → Models (spec 10 §4). The token state isn't exposed to this screen, so
  // gated repos route through the guided flow and disable the in-dialog download; the
  // enqueue endpoint is authoritative and returns 401/403 if the token is missing.
  const blockedByGate = gated

  const enqueueError = dlMut.enqueue.error instanceof ApiError ? dlMut.enqueue.error.message : null

  const onDownload = () => {
    if (!detail || !selectedFile) return
    dlMut.enqueue.mutate(
      { repo: detail.repo, rfilename: selectedFile.name, size: selectedFile.sizeBytes, sha256: selectedFile.sha256 },
      {
        onSuccess: () => {
          toast.success(`Downloading ${selectedFile.name}`)
          onClose()
        },
      },
    )
  }

  // Safetensors repos (MLX / vLLM) download all component files into a subdirectory.
  const onDownloadSafetensors = () => {
    if (!detail?.safetensors || !detail.files.length) return
    const subdir = detail.repo.split('/').pop() ?? detail.repo
    let queued = 0
    for (const f of detail.files) {
      dlMut.enqueue.mutate({ repo: detail.repo, rfilename: f.name, size: f.sizeBytes, sha256: f.sha256, subdir })
      queued++
    }
    toast.success(`Queued ${queued} files for ${subdir}`)
    onClose()
  }

  const onLoad = () => {
    const key = selectedFile?.localKey
    if (!key) return
    actions.load.mutate(
      { key },
      {
        onSuccess: () => {
          toast.success(`Loading ${selectedFile?.quant ?? 'model'}`)
          onClose()
        },
        onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not load model.'),
      },
    )
  }

  return (
    <Dialog open={!!repo} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="truncate pr-6">
            <span className="inline-flex items-center gap-1.5">
              {gated && <Lock size={14} style={{ color: 'var(--warn)' }} />}
              {repo}
            </span>
          </DialogTitle>
          <DialogDescription>
            {detail
              ? `${detail.downloads.toLocaleString()} downloads · ${detail.likes.toLocaleString()} likes${detail.license ? ` · ${detail.license}` : ''}`
              : 'Loading repo…'}
          </DialogDescription>
        </DialogHeader>

        {detailQ.isLoading ? (
          <div className="py-10 text-center text-[13px] text-muted">Loading repo…</div>
        ) : detailQ.isError ? (
          <UnreachableOrError
            error={detailQ.error}
            onRetry={() => detailQ.refetch()}
            onSearch={onSearch ? () => onSearch(repoSearchTerm(repo)) : undefined}
          />
        ) : isSafetensors ? (
          <MlxRepoBody
            detail={detail}
            vramMb={vramMb}
            engineKind={engineKind}
            onDownload={onDownloadSafetensors}
            isPending={dlMut.enqueue.isPending}
          />
        ) : !detail || ggufFiles.length === 0 ? (
          <div className="py-10 text-center text-[13px] text-muted">No GGUF files found in this repo.</div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Quant selector */}
            <div className="flex flex-col gap-1.5">
              <label className="flex items-center gap-1.5 text-[12px] font-medium text-ink">
                Quant
                {detail.verifying && (
                  <span className="text-[11px] font-normal text-faint">· checking your library…</span>
                )}
              </label>
              <select
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="w-full rounded-md border border-border bg-bg px-2 py-2 text-[13px] text-ink outline-none"
              >
                {ggufFiles.map((f) => {
                  const fFit = fileFit(f.sizeBytes, vramMb)
                  const isLocal = !!f.downloaded
                  const fitMark = fFit === 'fits' ? '●' : fFit === 'tight' ? '◐' : fFit === 'overflow' ? '○' : '·'
                  return (
                    <option key={f.name} value={f.name}>
                      {f.quant} · {fmtSize(f.sizeBytes)}
                      {f.parts > 1 ? ` · ${f.parts} parts` : ''} · {fitMark}
                      {isLocal ? ' · Downloaded' : ''}
                    </option>
                  )
                })}
              </select>
            </div>

            {/* VRAM verdict line */}
            {selectedFile && (
              <div className="flex items-center gap-2 rounded-md border border-border bg-panel-2 px-3 py-2.5 text-[12px]">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: FIT_COLOR[fit] }} />
                <span className="text-muted">
                  {FIT_LABEL[fit]}
                  {vramMb ? ` (${(selectedFile.sizeBytes / 1e9).toFixed(1)} GB file · ${(vramMb / 1024).toFixed(0)} GB VRAM)` : ''}
                </span>
              </div>
            )}

            {/* Gated guidance */}
            {blockedByGate && (
              <div className="rounded-md border px-3 py-2.5 text-[12px]" style={{ borderColor: 'var(--warn)', background: 'color-mix(in srgb, var(--warn) 10%, transparent)' }}>
                <p className="text-ink">This is a gated model.</p>
                <p className="mt-1 text-muted">
                  Accept the license on{' '}
                  <a href={`https://huggingface.co/${detail.repo}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 underline" style={{ color: 'var(--accent)' }}>
                    huggingface.co <ExternalLink size={11} />
                  </a>
                  , then add a Hugging Face token in Settings → Models.
                </p>
              </div>
            )}

            {enqueueError && <p className="text-[12px]" style={{ color: 'var(--err)' }}>{enqueueError}</p>}

            {/* Primary action */}
            <div className="flex items-center gap-2">
              {selectedIsLocal && selectedFile?.localKey ? (
                <Button className="flex-1" onClick={onLoad} disabled={actions.load.isPending}>
                  <Zap size={14} />
                  Load
                </Button>
              ) : (
                <Button
                  className="flex-1"
                  onClick={onDownload}
                  disabled={blockedByGate || dlMut.enqueue.isPending || !selectedFile}
                >
                  <Download size={14} />
                  {dlMut.enqueue.isPending ? 'Adding…' : selectedIsLocal ? 'Re-download' : 'Download'}
                </Button>
              )}
            </div>

            {/* Card preview */}
            {detail.card && (
              <details className="rounded-md border border-border bg-panel-2 px-3 py-2">
                <summary className="cursor-pointer text-[12px] font-medium text-muted">Model card</summary>
                <p className="mt-2 whitespace-pre-wrap text-[12px] leading-relaxed text-muted">{detail.card}</p>
              </details>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** Body shown for safetensors repos (MLX / vLLM) — no quant selection, whole-directory download. */
function MlxRepoBody({
  detail,
  vramMb,
  engineKind,
  onDownload,
  isPending,
}: {
  detail: { files: { sizeBytes: number }[]; gated: boolean }
  vramMb: number | undefined
  engineKind: string
  onDownload: () => void
  isPending: boolean
}) {
  const totalBytes = detail.files.reduce((s, f) => s + f.sizeBytes, 0)
  const fit = fileFit(totalBytes, vramMb)
  const description =
    engineKind === 'mlx'
      ? 'MLX model — runs on Apple Silicon via mlx-lm. Downloads as a directory of safetensors weights.'
      : engineKind === 'vllm'
        ? 'HuggingFace model — runs via vLLM. Downloads as a directory of safetensors weights.'
        : 'Safetensors model — downloads as a directory of weight files.'
  const btnLabel = engineKind === 'mlx' ? 'Download MLX model' : 'Download model'
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border border-border bg-panel-2 px-3 py-2.5 text-[12px] text-muted">
        {description}
      </div>

      <div className="flex items-center gap-2 rounded-md border border-border bg-panel-2 px-3 py-2.5 text-[12px]">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: FIT_COLOR[fit] }} />
        <span className="text-muted">
          {FIT_LABEL[fit]}
          {vramMb ? ` (${(totalBytes / 1e9).toFixed(1)} GB total · ${(vramMb / 1024).toFixed(0)} GB VRAM)` : `${(totalBytes / 1e9).toFixed(1)} GB total`}
        </span>
      </div>

      <Button className="w-full" onClick={onDownload} disabled={detail.gated || isPending}>
        <Download size={14} />
        {isPending ? 'Queuing…' : btnLabel}
      </Button>
    </div>
  )
}

/** Distinct copy per failure mode: a genuinely unreachable HF gets the offline line;
 *  a not-found repo (commonly an inferred id whose folder name doesn't match HF)
 *  explains that and offers a search instead of a dead-end Retry. */
function UnreachableOrError({ error, onRetry, onSearch }: { error: unknown; onRetry: () => void; onSearch?: () => void }) {
  const code = error instanceof ApiError ? error.code : ''
  const notFound = code === 'hf_not_found'
  const unreachable = code === 'hf_unreachable'
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center">
      <p className="max-w-sm text-[13px] text-muted">
        {notFound
          ? "We couldn't find this exact model on Hugging Face — the local folder name may not match its repo. Try searching for it instead."
          : unreachable
            ? 'Hugging Face is unreachable — check your connection.'
            : error instanceof ApiError
              ? error.message
              : 'Could not load this repo.'}
      </p>
      <div className="flex items-center gap-2">
        {notFound && onSearch && (
          <Button size="sm" onClick={onSearch}>Search Hugging Face</Button>
        )}
        <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
      </div>
    </div>
  )
}

/** Derive a search term from a repo id: drop the owner, strip a -GGUF suffix, and
 *  turn separators into spaces (e.g. "unsloth/Gemma-4-E4B-GGUF" → "Gemma 4 E4B"). */
function repoSearchTerm(repo: string | null): string {
  if (!repo) return ''
  const name = repo.split('/').pop() ?? repo
  return name.replace(/[-_]?gguf$/i, '').replace(/[-_]+/g, ' ').trim()
}

function fmtSize(b: number): string {
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`
}
