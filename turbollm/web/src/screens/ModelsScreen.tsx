import { useState, type ReactNode } from 'react'
import { Boxes, CircleSlash, FolderPlus, RefreshCw, SlidersHorizontal, X, Zap } from 'lucide-react'
import { ApiError } from '../lib/api'
import { useModelActions, useModelDirs, useModelMutations, useModels } from '../lib/queries'
import type { ModelEntry } from '../lib/types'
import { EmptyState, InlineError, ScreenHeader } from '../components/common'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Skeleton } from '../components/ui/skeleton'
import { ModelDetailDialog } from './models/ModelDetailDialog'

type Filter = 'all' | 'vision' | 'moe'

export function ModelsScreen() {
  const modelsQ = useModels()
  const dirsQ = useModelDirs()
  const mut = useModelMutations()
  const actions = useModelActions()
  const [filter, setFilter] = useState<Filter>('all')
  const [openKey, setOpenKey] = useState<string | null>(null)

  const scanning = modelsQ.data?.scanning ?? false
  const models = modelsQ.data?.models ?? []
  const dirs = dirsQ.data?.dirs ?? []
  const filtered = models.filter(
    (m) => filter === 'all' || (filter === 'vision' && m.vision) || (filter === 'moe' && m.moe),
  )

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <ScreenHeader
        title="Models"
        description="GGUF models discovered in your folders — reuse what you already have, no re-downloading."
        actions={
          <Button variant="outline" size="sm" onClick={() => mut.rescan.mutate()} disabled={scanning}>
            <RefreshCw size={14} className={scanning ? 'tllm-pulse' : ''} />
            {scanning ? 'Scanning…' : 'Rescan'}
          </Button>
        }
      />

      <ModelDirs dirs={dirs} mut={mut} />

      {models.length > 0 && (
        <div className="mb-4 flex items-center gap-2">
          {(['all', 'vision', 'moe'] as Filter[]).map((f) => (
            <FilterChip key={f} active={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? `All ${models.length}` : f === 'vision' ? 'Vision' : 'MoE'}
            </FilterChip>
          ))}
        </div>
      )}

      {modelsQ.isLoading ? (
        <div className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[58px] w-full rounded-lg" />
          ))}
        </div>
      ) : modelsQ.isError ? (
        <InlineError message="Could not load models." onRetry={() => modelsQ.refetch()} />
      ) : models.length === 0 ? (
        <EmptyState
          icon={<Boxes size={24} />}
          message={
            dirs.length === 0
              ? 'No model folders yet. Add a folder above to discover the GGUF models you already have.'
              : scanning
                ? 'Scanning your folders…'
                : 'No GGUF models found in your folders.'
          }
        />
      ) : (
        <div className="flex flex-col gap-2">
          {filtered.map((m) => (
            <ModelRow
              key={m.key}
              m={m}
              onLoad={() => actions.load.mutate({ key: m.key })}
              onEject={() => actions.eject.mutate()}
              onTune={() => setOpenKey(m.key)}
              loading={actions.load.isPending}
              ejecting={actions.eject.isPending}
            />
          ))}
        </div>
      )}

      <ModelDetailDialog modelKey={openKey} onClose={() => setOpenKey(null)} />
    </div>
  )
}

function ModelRow({
  m,
  onLoad,
  onEject,
  onTune,
  loading,
  ejecting,
}: {
  m: ModelEntry
  onLoad: () => void
  onEject: () => void
  onTune: () => void
  loading: boolean
  ejecting: boolean
}) {
  const loadable = !m.incomplete && !m.parseError
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-panel px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-medium text-ink">{m.name}</span>
          {m.loaded && <Tag tone="ok">loaded</Tag>}
          {m.vision && <Tag>vision</Tag>}
          {m.moe && <Tag>MoE</Tag>}
          {m.hasProfile && <Tag>tuned</Tag>}
          {m.incomplete && <Tag tone="warn">missing parts</Tag>}
          {m.parseError && <Tag tone="err">unreadable</Tag>}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-muted">
          {m.arch}
          {m.dir ? ` · ${m.dir}` : ''}
        </div>
      </div>
      <Badge variant="mono">{m.quant}</Badge>
      <Stat>{fmtSize(m.sizeBytes)}</Stat>
      <Stat>{m.nativeCtx ? `${fmtCtx(m.nativeCtx)} ctx` : '—'}</Stat>
      <Stat>{m.benchTps ? `${m.benchTps} t/s` : '—'}</Stat>
      <div className="flex items-center gap-1">
        <Button size="sm" onClick={onLoad} disabled={!loadable || loading} title={loadable ? '' : 'Model is incomplete or unreadable'}>
          <Zap size={14} />
          {m.loaded ? 'Reload' : 'Load'}
        </Button>
        {m.loaded && (
          <Button size="sm" variant="outline" onClick={onEject} disabled={ejecting} title="Eject model (stop the engine)">
            <CircleSlash size={14} />
            Eject
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={onTune} disabled={!loadable} title="Load settings">
          <SlidersHorizontal size={14} />
        </Button>
      </div>
    </div>
  )
}

function ModelDirs({ dirs, mut }: { dirs: string[]; mut: ReturnType<typeof useModelMutations> }) {
  const [value, setValue] = useState('')
  const addError = mut.addDir.error instanceof ApiError ? mut.addDir.error.message : null

  const add = () => {
    const dir = value.trim()
    if (!dir) return
    mut.addDir.mutate(dir, { onSuccess: () => setValue('') })
  }

  return (
    <div className="mb-5 rounded-lg border border-border bg-panel-2 p-4">
      <div className="mb-2 text-[13px] font-medium text-ink">Model folders</div>
      {dirs.length > 0 && (
        <div className="mb-3 flex flex-col gap-1.5">
          {dirs.map((d) => (
            <div key={d} className="flex items-center gap-2 text-[13px]">
              <span className="flex-1 truncate font-mono text-muted">{d}</span>
              <button
                type="button"
                aria-label={`Remove ${d}`}
                onClick={() => mut.removeDir.mutate(d)}
                className="rounded p-1 text-muted transition-colors hover:text-ink"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
          placeholder="Paste an absolute folder path, e.g. D:\\models"
          className="flex-1 font-mono text-[13px]"
        />
        <Button size="sm" onClick={add} disabled={mut.addDir.isPending || !value.trim()}>
          <FolderPlus size={14} />
          Add folder
        </Button>
      </div>
      {addError && <p className="mt-2 text-[12px]" style={{ color: 'var(--err)' }}>{addError}</p>}
    </div>
  )
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border px-3 py-1 text-[12px] font-medium transition-colors"
      style={{
        borderColor: active ? 'var(--accent)' : 'var(--border)',
        background: active ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--muted)',
      }}
    >
      {children}
    </button>
  )
}

function Tag({ children, tone }: { children: ReactNode; tone?: 'ok' | 'warn' | 'err' }) {
  const color = tone ? `var(--${tone})` : 'var(--muted)'
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      {children}
    </span>
  )
}

function Stat({ children }: { children: ReactNode }) {
  return <div className="w-[72px] text-right text-[13px] text-muted">{children}</div>
}

function fmtSize(b: number): string {
  return b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`
}
function fmtCtx(n: number): string {
  return n >= 1024 ? `${Math.round(n / 1024)}K` : String(n)
}
