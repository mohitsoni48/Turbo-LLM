import { useMemo } from 'react'
import { Check, ChevronDown, Cpu, Layers, Sparkles } from 'lucide-react'
import { useBackendInstall, useEngineMutations } from '../../lib/queries'
import { ApiError } from '../../lib/api'
import type { EngineBackends, EnginesList } from '../../lib/types'
import { toast } from '../../components/ui/sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu'

/** Auto-downloaded official llama.cpp builds live in
 *  `<config>/engines/llama.cpp-<tag>-<backend>/`; everything else is a user fork. */
const isOfficialLlama = (binPath: string) => /[\\/]engines[\\/]llama\.cpp-/.test(binPath)

// A "build" = a specific compiled backend of an engine (Layer 2).
type BuildOption = {
  key: string
  label: string
  installed: boolean
  active: boolean
  recommended: boolean
  engineId: string // registry engine to activate (empty until installed)
  backendId: string // official backend id to download (empty for forks/MLX)
}

// An "engine" = a runtime / distribution (Layer 1): Official, a user fork, MLX.
type EngineGroup = {
  key: string
  name: string
  kind: 'official' | 'custom' | 'mlx'
  builds: BuildOption[]
  active: boolean
}

/** Compose the flat registry + official backends into the two-level
 *  Engine → Build model the UI selects from. */
function buildGroups(list: EnginesList, backends: EngineBackends): EngineGroup[] {
  const groups: EngineGroup[] = []

  // Whether the active engine is an official llama.cpp build — derived from the
  // engines list (reliably refetched on activation), not the backends projection.
  const activeEng = list.engines.find((e) => e.id === list.activeEngineId)
  const officialActive = !!activeEng && isOfficialLlama(activeEng.binPath)

  // Layer 1: Official llama.cpp — its builds are the official backends.
  const officialBuilds: BuildOption[] = backends.backends.map((b) => ({
    key: `official:${b.id}`,
    label: b.label,
    installed: b.installed,
    active: b.active,
    recommended: b.recommended,
    engineId: b.engineId,
    backendId: b.id,
  }))
  groups.push({
    key: 'official',
    name: 'Official llama.cpp',
    kind: 'official',
    builds: officialBuilds,
    active: officialActive,
  })

  // Layer 1: each user-added fork — its own engine, a single build (itself).
  for (const e of list.engines) {
    if (e.kind === 'mlx' || isOfficialLlama(e.binPath)) continue
    const active = e.id === list.activeEngineId
    groups.push({
      key: `custom:${e.id}`,
      name: e.name,
      kind: 'custom',
      active,
      builds: [
        {
          key: `custom:${e.id}`,
          label: e.version || 'custom build',
          installed: true,
          active,
          recommended: false,
          engineId: e.id,
          backendId: '',
        },
      ],
    })
  }

  // Layer 1: MLX (macOS) — one build.
  if (backends.mlx.supported || backends.mlx.installed) {
    groups.push({
      key: 'mlx',
      name: 'MLX',
      kind: 'mlx',
      active: backends.mlx.active,
      builds: [
        {
          key: 'mlx',
          label: 'Apple Metal',
          installed: backends.mlx.installed,
          active: backends.mlx.active,
          recommended: false,
          engineId: backends.mlx.engineId,
          backendId: '',
        },
      ],
    })
  }

  return groups
}

/**
 * Two-level engine selector (Engine → Build). The Engine dropdown selects the
 * engine (the management list below follows this selection) and activates it
 * when it has an installed build. The Build dropdown appears only when the
 * selected engine has more than one build (i.e. Official llama.cpp's GPU
 * backends); single-build engines (forks, MLX) have no Build dropdown.
 *
 * Selection is controlled by the parent (`selectedKey`/`onSelect`) so the
 * builds shown below this selector change with the chosen engine.
 */
export function EngineSelector({
  list,
  backends,
  provisioning,
  selectedKey,
  onSelect,
}: {
  list: EnginesList | undefined
  backends: EngineBackends | undefined
  provisioning: boolean
  selectedKey: string
  onSelect: (key: string) => void
}) {
  const mut = useEngineMutations()
  const install = useBackendInstall()

  const groups = useMemo(
    () => (list && backends ? buildGroups(list, backends) : []),
    [list, backends],
  )

  if (!list || !backends) return null

  const selectedEngine =
    groups.find((g) => g.key === selectedKey) ?? groups.find((g) => g.active) ?? groups[0]
  const busy = provisioning || mut.activate.isPending || install.backend.isPending

  // Activate an installed build, or download (then activate) an uninstalled official one.
  // previousKey: the selected key before any optimistic onSelect call — used to revert on error.
  const selectBuild = (b: BuildOption, previousKey?: string) => {
    if (b.active) return
    if (b.installed && b.engineId) {
      mut.activate.mutate(b.engineId, {
        onError: (e) => {
          if (previousKey !== undefined) onSelect(previousKey)
          toast.error(e instanceof ApiError ? e.message : 'Could not switch engine.')
        },
      })
    } else if (b.backendId) {
      install.backend.mutate(b.backendId, {
        onError: (e) => {
          if (previousKey !== undefined) onSelect(previousKey)
          toast.error(e instanceof ApiError ? e.message : 'Could not download build.')
        },
      })
    } else {
      toast.error('Install this build first (use the list below).')
    }
  }

  // Picking an engine selects it (the list below follows) and activates it when
  // it has an installed build. Official with no installed build just shows its
  // builds list below so the user can download one — no error, no dead-end.
  const pickEngine = (g: EngineGroup) => {
    const previousKey = selectedKey
    onSelect(g.key)
    if (g.active) return
    if (g.kind === 'official') {
      const target =
        g.builds.find((b) => b.installed && b.recommended) ?? g.builds.find((b) => b.installed)
      if (target) selectBuild(target, previousKey)
    } else {
      selectBuild(g.builds[0], previousKey)
    }
  }

  // The Build dropdown appears only for engines with more than one build —
  // i.e. Official's GPU backends. Forks/MLX have a single build, so it's hidden.
  const showBuilds = (selectedEngine?.builds.length ?? 0) > 1
  const activeBuild = selectedEngine?.builds.find((b) => b.active)

  return (
    <div className="flex flex-wrap items-end gap-3">
      {/* Layer 1 — Engine */}
      <Field label="Engine">
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={busy}
            className="flex h-9 min-w-[200px] items-center gap-2 rounded-lg border border-border bg-bg px-3 text-[13px] text-ink transition-colors hover:border-[color:var(--accent)] disabled:opacity-60"
          >
            <Cpu size={15} className={selectedEngine?.active ? 'text-accent' : 'text-muted'} />
            <span className="flex-1 truncate text-left">
              {selectedEngine?.name ?? 'No engine'}
            </span>
            <ChevronDown size={14} className="shrink-0 text-muted" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[260px]">
            <MenuHeading>Engine — the runtime / fork</MenuHeading>
            {groups.map((g) => (
              <DropdownMenuItem
                key={g.key}
                onSelect={() => pickEngine(g)}
                className="flex items-center gap-2"
              >
                <Tick on={g.active} />
                <span className="min-w-0 flex-1 truncate text-ink">{g.name}</span>
                {g.active && <span className="shrink-0 text-[11px] text-accent">active</span>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </Field>

      {/* Layer 2 — Build (Official only, when active) */}
      {showBuilds && (
        <Field label="Build">
          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={busy}
              className="flex h-9 min-w-[180px] items-center gap-2 rounded-lg border border-border bg-bg px-3 text-[13px] text-ink transition-colors hover:border-[color:var(--accent)] disabled:opacity-60"
            >
              <Layers size={15} className="text-accent" />
              <span className="flex-1 truncate text-left">
                {activeBuild?.label ?? 'Choose a build'}
              </span>
              <ChevronDown size={14} className="shrink-0 text-muted" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[260px]">
              <MenuHeading>Build — which GPU backend</MenuHeading>
              {selectedEngine.builds.map((b) => (
                <DropdownMenuItem
                  key={b.key}
                  onSelect={() => selectBuild(b)}
                  className="flex items-center gap-2"
                >
                  <Tick on={b.active} />
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
        </Field>
      )}
    </div>
  )
}

// ── small presentational helpers ────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-faint">{label}</span>
      {children}
    </label>
  )
}

function MenuHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
      {children}
    </div>
  )
}

function Tick({ on }: { on: boolean }) {
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center">
      {on && <Check size={14} className="text-accent" />}
    </span>
  )
}
