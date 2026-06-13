// Discover tab (spec 10 §2, §7, §8). A debounced HF search (400ms) with result
// rows, a Featured rail shown when no query is active, an Import-from-URL entry, and
// the live Downloads panel. Clicking a featured card or result row opens the
// HfRepoDialog. Offline/HF-unreachable search errors render a friendly card instead
// of results.

import { useEffect, useState } from 'react'
import { Heart, Link2, Lock, Search, Sparkles } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { useHfSearch, useModels, useSysInfo } from '../../lib/queries'
import type { HfSearchItem, ModelEntry } from '../../lib/types'
import { FEATURED_REPOS, vramTier, type FeaturedRepo } from '../../lib/featured'
import { EmptyState, InlineError } from '../../components/common'
import { Input } from '../../components/ui/input'
import { Skeleton } from '../../components/ui/skeleton'
import { DownloadsPanel } from './DownloadsPanel'
import { HfRepoDialog } from './HfRepoDialog'
import { ImportUrlDialog } from './ImportUrlDialog'

/** A repo id (owner/name) is "in library" when a local model's path or name matches
 *  the repo's name segment. The search payload also carries `localCount`; this is a
 *  client-side fallback for the Featured rail (which has no localCount). */
function repoInLibrary(repo: string, models: ModelEntry[]): boolean {
  const name = (repo.split('/').pop() ?? repo).toLowerCase()
  // Strip a trailing "-gguf" so "Qwen3.6-27B-GGUF" matches a local "Qwen3.6-27B".
  const stem = name.replace(/-gguf$/, '')
  return models.some((m) => {
    const hay = `${m.name} ${m.path}`.toLowerCase()
    return hay.includes(stem)
  })
}

export function DiscoverTab() {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [openRepo, setOpenRepo] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  // Debounce the search input 400ms before it hits the network (spec 10 §2).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 400)
    return () => clearTimeout(t)
  }, [query])

  const searchQ = useHfSearch(debounced)
  const modelsQ = useModels()
  const sysQ = useSysInfo()
  const models = modelsQ.data?.models ?? []
  const tier = vramTier(sysQ.data?.gpus?.[0]?.vramMb)

  const searching = debounced.length > 0
  const unreachable = searchQ.error instanceof ApiError && searchQ.error.code === 'hf_unreachable'
  const results = searchQ.data?.results ?? []

  return (
    <div>
      <DownloadsPanel />

      {/* Search + import bar */}
      <div className="mb-5 flex items-center gap-2">
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search Hugging Face for GGUF models, e.g. qwen3.6 gguf"
            className="pl-9"
          />
        </div>
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-transparent px-3 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-panel-2"
        >
          <Link2 size={14} />
          Import from URL
        </button>
      </div>

      {/* Featured rail (only when not searching) */}
      {!searching && (
        <FeaturedRail
          repos={FEATURED_REPOS}
          tier={tier}
          models={models}
          onOpen={(repo) => setOpenRepo(repo)}
        />
      )}

      {/* Search results */}
      {searching && (
        <div className="flex flex-col gap-2">
          {searchQ.isLoading ? (
            [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[58px] w-full rounded-lg" />)
          ) : unreachable ? (
            <InlineError
              message="Hugging Face is unreachable — check your connection."
              onRetry={() => searchQ.refetch()}
            />
          ) : searchQ.isError ? (
            <InlineError
              message={searchQ.error instanceof ApiError ? searchQ.error.message : 'Search failed.'}
              onRetry={() => searchQ.refetch()}
            />
          ) : results.length === 0 ? (
            <EmptyState icon={<Search size={24} />} message={`No GGUF repos found for “${debounced}”.`} />
          ) : (
            results.map((r) => (
              <ResultRow key={r.repo} item={r} onOpen={() => setOpenRepo(r.repo)} />
            ))
          )}
        </div>
      )}

      <HfRepoDialog repo={openRepo} onClose={() => setOpenRepo(null)} />
      <ImportUrlDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  )
}

function FeaturedRail({
  repos,
  tier,
  models,
  onOpen,
}: {
  repos: FeaturedRepo[]
  tier: ReturnType<typeof vramTier>
  models: ModelEntry[]
  onOpen: (repo: string) => void
}) {
  return (
    <div className="mb-2">
      <div className="mb-3 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-faint">
        <Sparkles size={13} />
        Featured
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {repos.map((f) => {
          const inLib = repoInLibrary(f.repo, models)
          return (
            <button
              key={f.repo}
              type="button"
              onClick={() => onOpen(f.repo)}
              className="flex flex-col gap-1.5 rounded-lg border border-border bg-panel px-4 py-3 text-left transition-colors hover:border-border-strong hover:bg-panel-2"
            >
              <div className="flex items-center gap-1.5">
                {f.gated && <Lock size={13} style={{ color: 'var(--warn)' }} className="shrink-0" />}
                <span className="truncate font-medium text-ink">{f.name}</span>
                {inLib && <InLibraryChip />}
              </div>
              <p className="line-clamp-2 text-[12px] text-muted">{f.blurb}</p>
              <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint">
                <span>Suggested for your GPU:</span>
                <span className="rounded px-1.5 py-0.5 font-mono" style={{ color: 'var(--accent)', background: 'color-mix(in srgb, var(--accent) 12%, transparent)' }}>
                  {f.quants[tier]}
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ResultRow({ item, onOpen }: { item: HfSearchItem; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex items-center gap-3 rounded-lg border border-border bg-panel px-4 py-3 text-left transition-colors hover:border-border-strong hover:bg-panel-2"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          {item.gated && <Lock size={13} style={{ color: 'var(--warn)' }} className="shrink-0" />}
          <span className="truncate font-medium text-ink">{item.repo}</span>
          {item.localCount > 0 && <InLibraryChip count={item.localCount} />}
        </div>
        <div className="mt-0.5 flex items-center gap-3 text-[12px] text-muted">
          <span>{fmtCount(item.downloads)} downloads</span>
          <span className="inline-flex items-center gap-1">
            <Heart size={11} /> {fmtCount(item.likes)}
          </span>
          {item.updatedAt && <span>updated {fmtDate(item.updatedAt)}</span>}
        </div>
      </div>
    </button>
  )
}

/** Green "in library" chip (spec 10 §2). With a count it reads "↓ N in library";
 *  without (Featured rail) it reads "✓ in library". */
function InLibraryChip({ count }: { count?: number }) {
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
      style={{ color: 'var(--ok)', background: 'color-mix(in srgb, var(--ok) 14%, transparent)' }}
    >
      {count != null ? `↓ ${count} in library` : '✓ in library'}
    </span>
  )
}

function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`
  return String(n)
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
