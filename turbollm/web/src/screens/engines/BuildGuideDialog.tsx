import { useEffect, useRef, useState } from 'react'
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Hammer,
  Loader2,
  Plus,
  RefreshCw,
  X,
  XCircle,
} from 'lucide-react'
import { useBuild, useBuildPrereqs, useSettings, useStatus } from '../../lib/queries'
import type { BuildPrereqTool, EngineBuild } from '../../lib/types'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog'
import { AddEngineDialog } from './AddEngineDialog'

/** The exact Windows + CUDA build command list for a repo (mirrors the backend's PURE
 *  `buildCommands` in src/engines/build-prereqs.ts — kept in lockstep so the manual path
 *  matches what the 1-click build runs). */
function buildCommands(repoUrl: string, branch?: string): string[] {
  const b = (branch ?? '').trim()
  const clone = b
    ? `git clone --branch ${b} --depth 1 ${repoUrl} turbo-build`
    : `git clone --depth 1 ${repoUrl} turbo-build`
  return [
    clone,
    'cd turbo-build',
    'cmake -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release',
    'cmake --build build --config Release -j --target llama-server',
    '# Built binary: build\\bin\\Release\\llama-server.exe — add it via "Add your own engine".',
  ]
}

const PHASE_LABEL: Record<EngineBuild['phase'], string> = {
  preparing: 'Preparing…',
  cloning: 'Cloning the repository…',
  configuring: 'Configuring (cmake)…',
  compiling: 'Compiling llama-server… this can take several minutes',
  registering: 'Registering the built engine…',
  done: 'Built and registered ✓',
  error: 'Build failed',
}

/** Compile-from-source dialog (ADR-089 + ADR-100). On Windows + CUDA: a prereq checklist,
 *  an editable "Build environment" (PATH dirs so a conda-env / custom CUDA Toolkit is found),
 *  a 1-click "Build it for me" that clones + compiles + registers in-app with live progress,
 *  and the manual command path as a fallback. Off Windows the guided build is parked. */
export function BuildGuideDialog({
  open,
  onOpenChange,
  repoUrl,
  engineName,
  branch,
  mode = 'build',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoUrl: string
  engineName: string
  branch?: string
  /** 'rebuild' relabels the action for the ADR-088 "newer source" chip. */
  mode?: 'build' | 'rebuild'
}) {
  // Only probe the toolchain while the dialog is open.
  const prereqsQ = useBuildPrereqs(open)
  const settings = useSettings()
  const statusQ = useStatus()
  const build = useBuild()
  const [copied, setCopied] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [buildStarted, setBuildStarted] = useState(false)

  // Build-environment editor draft (null until edited → show the saved dirs).
  const savedDirs = settings.query.data?.build.toolchainDirs ?? []
  const [draftDirs, setDraftDirs] = useState<string[] | null>(null)
  const dirs = draftDirs ?? savedDirs

  const commands = buildCommands(repoUrl, branch)
  const commandText = commands.join('\n')

  const supported = prereqsQ.data?.supported ?? null
  const tools = prereqsQ.data?.tools ?? []
  const missingRequired = tools.filter((t) => (t.id === 'git' || t.id === 'cmake' || t.id === 'cuda') && !t.found)

  const engineBuild = statusQ.data?.engineBuild
  const buildActive = !!engineBuild?.active
  const provisionActive = !!statusQ.data?.engineProvision?.active
  const showProgress = buildStarted || buildActive
  const canBuild = supported === true && missingRequired.length === 0 && !buildActive && !provisionActive

  // When a build we kicked off settles, pull the new/updated engine into the lists.
  useEffect(() => {
    if (buildStarted && engineBuild && !engineBuild.active && (engineBuild.phase === 'done' || engineBuild.phase === 'error')) {
      build.refresh()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buildStarted, engineBuild?.active, engineBuild?.phase])

  // Auto-scroll the log to the newest line.
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [engineBuild?.log])

  const copy = () => {
    void navigator.clipboard.writeText(commandText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const recheck = async () => {
    // Persist the edited dirs (filtering blanks), then re-probe with the new PATH.
    await settings.save.mutateAsync({ build: { toolchainDirs: dirs.map((d) => d.trim()).filter(Boolean) } })
    setDraftDirs(null)
    void prereqsQ.refetch()
  }

  const startBuild = () => {
    setBuildStarted(true)
    build.start.mutate({ repoUrl, branch, name: engineName })
  }

  const actionLabel = mode === 'rebuild' ? 'Rebuild now' : 'Build it for me'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === 'rebuild' ? 'Rebuild' : 'Build'} {engineName} from source
          </DialogTitle>
          <DialogDescription>
            {mode === 'rebuild'
              ? 'A newer commit is available — recompile from source and replace the binary.'
              : 'No prebuilt binary for your system — compile it here, or build it yourself and add it.'}
          </DialogDescription>
        </DialogHeader>

        {prereqsQ.isLoading ? (
          <div className="flex items-center gap-3 rounded-lg border border-border bg-panel p-4 text-[13px] text-muted">
            <Loader2 size={18} className="shrink-0 animate-spin text-ink" />
            Checking your build tools…
          </div>
        ) : supported === false ? (
          // Parked OS (Linux/macOS): point at the repo + upstream build docs.
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-border bg-panel p-4 text-[13px] text-muted">
              In-app build is currently <span className="font-medium text-ink">Windows + CUDA</span> only.
              On your system, clone the repo and follow its upstream build instructions, then add the
              resulting <code className="font-mono">llama-server</code> binary via “Add your own engine”.
            </div>
            <a
              href={repoUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 self-start text-[13px] text-accent hover:underline"
            >
              Open {engineName} repo + build docs <ExternalLink size={13} />
            </a>
          </div>
        ) : (
          <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
            {/* Prereq checklist */}
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Build prerequisites</p>
              <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-panel p-3">
                {tools.map((t) => (
                  <PrereqRow key={t.id} tool={t} />
                ))}
              </div>
            </div>

            {/* Build environment (PATH override) — ADR-100 */}
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-faint">Build environment</p>
              <div className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-3">
                <p className="text-[12px] text-muted">
                  If your CUDA Toolkit or compiler lives in a conda env or a custom location (not on the
                  system PATH), add that folder — e.g. the env’s <code className="font-mono">bin</code> — so
                  TurboLLM finds <code className="font-mono">nvcc</code>. Then re-check.
                </p>
                {dirs.map((dir, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input
                      value={dir}
                      onChange={(e) => {
                        const next = [...dirs]
                        next[i] = e.target.value
                        setDraftDirs(next)
                      }}
                      placeholder="C:\\Users\\you\\miniconda3\\envs\\cuda\\Library\\bin"
                      className="min-w-0 flex-1 rounded-md border border-border bg-panel-2 px-2 py-1 font-mono text-[12px] text-ink outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={() => setDraftDirs(dirs.filter((_, j) => j !== i))}
                      className="shrink-0 rounded-md p-1 text-faint hover:text-ink"
                      aria-label="Remove folder"
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setDraftDirs([...dirs, ''])}
                    className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink"
                  >
                    <Plus size={13} /> Add folder
                  </button>
                  <button
                    type="button"
                    onClick={() => void recheck()}
                    disabled={settings.save.isPending || prereqsQ.isFetching}
                    className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline disabled:opacity-50"
                  >
                    {settings.save.isPending || prereqsQ.isFetching ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <RefreshCw size={13} />
                    )}
                    Re-check
                  </button>
                </div>
              </div>
            </div>

            {/* Live build progress (ADR-100) */}
            {showProgress && engineBuild && (
              <BuildProgress build={engineBuild} logRef={logRef} onCancel={() => build.cancel.mutate()} />
            )}

            {/* Manual build commands (fallback / transparency) */}
            <details className="group">
              <summary className="cursor-pointer list-none text-[11px] font-medium uppercase tracking-wide text-faint hover:text-muted">
                Or build it yourself (manual commands)
              </summary>
              <div className="mt-1.5 flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <p className="text-[11px] text-faint">Windows + CUDA</p>
                  <button
                    type="button"
                    onClick={copy}
                    className="inline-flex items-center gap-1 text-[12px] text-muted hover:text-ink"
                  >
                    {copied ? <CheckCircle2 size={13} style={{ color: 'var(--ok)' }} /> : <Copy size={13} />}
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-lg border border-border bg-panel-2 p-3 font-mono text-[12px] leading-relaxed text-ink">
                  {commandText}
                </pre>
              </div>
            </details>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {supported !== false && (
            <>
              <Button variant="outline" onClick={() => setAddOpen(true)} disabled={prereqsQ.isLoading || buildActive}>
                I&apos;ve built it
              </Button>
              <Button onClick={startBuild} disabled={!canBuild}>
                <Hammer size={15} className="mr-1.5" />
                {buildActive ? 'Building…' : actionLabel}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>

      {/* Hand-off: open Add-engine with the source repo prefilled (ADR-088 tracking). */}
      <AddEngineDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        defaultSourceRepo={repoUrl}
        trigger={null}
      />
    </Dialog>
  )
}

/** Live phase + scrolling log while a build runs, with a Cancel while active. */
function BuildProgress({
  build,
  logRef,
  onCancel,
}: {
  build: EngineBuild
  logRef: React.RefObject<HTMLPreElement | null>
  onCancel: () => void
}) {
  const isError = build.phase === 'error'
  const isDone = build.phase === 'done'
  const accent = isError ? 'var(--err, #ef4444)' : isDone ? 'var(--ok)' : 'var(--accent)'
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-panel p-3">
      <div className="flex items-center gap-2 text-[13px]">
        {build.active ? (
          <Loader2 size={15} className="shrink-0 animate-spin" style={{ color: accent }} />
        ) : isError ? (
          <XCircle size={15} className="shrink-0" style={{ color: accent }} />
        ) : (
          <CheckCircle2 size={15} className="shrink-0" style={{ color: accent }} />
        )}
        <span className="text-ink">{PHASE_LABEL[build.phase]}</span>
        {build.active && (
          <button type="button" onClick={onCancel} className="ml-auto text-[12px] text-faint hover:text-ink">
            Cancel
          </button>
        )}
      </div>
      {isError && build.error && <p className="text-[12px]" style={{ color: accent }}>{build.error}</p>}
      {build.log.length > 0 && (
        <pre
          ref={logRef}
          className="max-h-40 overflow-auto rounded-md border border-border bg-panel-2 p-2 font-mono text-[11px] leading-relaxed text-muted"
        >
          {build.log.join('\n')}
        </pre>
      )}
    </div>
  )
}

/** One prereq row: ✓ found (with version) or ✗ missing (with an install link). */
function PrereqRow({ tool }: { tool: BuildPrereqTool }) {
  return (
    <div className="flex items-center gap-2 text-[13px]">
      {tool.found ? (
        <CheckCircle2 size={15} className="shrink-0" style={{ color: 'var(--ok)' }} />
      ) : (
        <XCircle size={15} className="shrink-0 text-faint" />
      )}
      <span className="text-ink">{tool.name}</span>
      {tool.found && tool.version && <span className="text-[12px] text-muted">{tool.version}</span>}
      {!tool.found && (
        <a
          href={tool.installUrl}
          target="_blank"
          rel="noreferrer"
          className="ml-auto inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
        >
          Install <ExternalLink size={11} />
        </a>
      )}
    </div>
  )
}
