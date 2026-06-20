import { useState } from 'react'
import { CheckCircle2, Copy, ExternalLink, Loader2, XCircle } from 'lucide-react'
import { useBuildPrereqs } from '../../lib/queries'
import type { BuildPrereqTool } from '../../lib/types'
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
 *  `buildCommands` in src/engines/build-prereqs.ts — kept in lockstep so the guide shows
 *  what the docs describe). */
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

/** Guided compile-from-source dialog (ADR-089). GUIDED only — we never build in-app.
 *  On Windows: a prereq checklist (with install links for what's missing), the exact
 *  Windows + CUDA build commands with a copy button, then a hand-off to "Add your own
 *  engine" with the repo prefilled. Off Windows the guided build is parked, so we just
 *  point at the repo + its upstream build docs. */
export function BuildGuideDialog({
  open,
  onOpenChange,
  repoUrl,
  engineName,
  branch,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoUrl: string
  engineName: string
  branch?: string
}) {
  // Only probe the toolchain while the dialog is open.
  const prereqsQ = useBuildPrereqs(open)
  const [copied, setCopied] = useState(false)
  const [addOpen, setAddOpen] = useState(false)

  const commands = buildCommands(repoUrl, branch)
  const commandText = commands.join('\n')

  const copy = () => {
    void navigator.clipboard.writeText(commandText).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const supported = prereqsQ.data?.supported ?? null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Build {engineName} from source</DialogTitle>
          <DialogDescription>
            No prebuilt binary for your system — compile it yourself, then add the binary.
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
              Guided build is currently <span className="font-medium text-ink">Windows + CUDA</span> only.
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
          <div className="flex flex-col gap-4">
            {/* Prereq checklist */}
            <div className="flex flex-col gap-1.5">
              <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
                Build prerequisites
              </p>
              <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-panel p-3">
                {(prereqsQ.data?.tools ?? []).map((t) => (
                  <PrereqRow key={t.id} tool={t} />
                ))}
              </div>
            </div>

            {/* Build commands */}
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-medium uppercase tracking-wide text-faint">
                  Build commands (Windows + CUDA)
                </p>
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
              <a
                href={repoUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 self-start text-[12px] text-muted hover:text-ink"
              >
                Open {engineName} repo <ExternalLink size={11} />
              </a>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {supported !== false && (
            <Button onClick={() => setAddOpen(true)} disabled={prereqsQ.isLoading}>
              I&apos;ve built it → Add your own engine
            </Button>
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
