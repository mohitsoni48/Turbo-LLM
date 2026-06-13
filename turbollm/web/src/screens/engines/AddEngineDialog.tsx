import { useState } from 'react'
import { FolderOpen, Plus } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { useEngineMutations, useSysInfo } from '../../lib/queries'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog'
import { InlineError } from '../../components/common'
import { toast } from '../../components/ui/sonner'
import { FsBrowser } from './FsBrowser'

/** Add-engine dialog: name + absolute binPath. On success closes + refetches; on
 *  error (binary_not_found / probe_failed) shows error.message inline and stays
 *  open (spec 03 §9, brief). */
export function AddEngineDialog() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [binPath, setBinPath] = useState('')
  // Spec 03 §2 renders each error under the offending field: name_already_taken
  // belongs to the Name field, every other code (path/probe) to the Binary path.
  const [nameError, setNameError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [browseOpen, setBrowseOpen] = useState(false)
  const { add } = useEngineMutations()
  const { data: sys } = useSysInfo()

  // Placeholder must reflect the DAEMON's OS, not the browser's — the UI may be
  // open on a Mac while the daemon (which runs the engine) is on Windows (LAN
  // access, ADR-009). sys.os is like "win32/x64" / "darwin/arm64" / "linux/x64".
  const isWin = sys?.os.split('/')[0] === 'win32'
  const binExample = isWin ? 'C:\\path\\to\\llama-server.exe' : '/path/to/llama-server'

  const reset = () => {
    setName('')
    setBinPath('')
    setNameError(null)
    setError(null)
  }

  const submit = () => {
    setNameError(null)
    setError(null)
    add.mutate(
      { name: name.trim(), binPath: binPath.trim() },
      {
        onSuccess: (eng) => {
          // probe_no_version (spec 03 §2): the engine saved but its version is
          // unknown — surface a non-blocking warning instead of a success toast.
          if (eng.warning === 'no_version') {
            toast.warning('Engine added, but its version could not be detected.')
          } else {
            toast.success('Engine added')
          }
          setOpen(false)
          reset()
        },
        onError: (e) => {
          const code = e instanceof ApiError ? e.code : ''
          const msg = e instanceof ApiError ? e.message : 'Could not add engine.'
          // Route name_already_taken to the Name field, everything else to path.
          if (code === 'name_already_taken') setNameError(msg)
          else setError(msg)
        },
      },
    )
  }

  const canSubmit = name.trim().length > 0 && binPath.trim().length > 0 && !add.isPending

  return (
    <Dialog
      open={open}
      onOpenChange={(o: boolean) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <Plus size={16} /> Add engine
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add engine</DialogTitle>
          <DialogDescription>
            Point TurboLLM at any llama-server compatible binary — mainline llama.cpp,
            or any community fork.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink">Name</span>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="TurboQuant llama.cpp"
              autoFocus
            />
            <span className="text-[12px] text-muted">
              Any label you choose — shown in the engine list. Not a filename.
            </span>
            {nameError && <InlineError message={nameError} />}
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink">Binary path</span>
            <div className="flex items-center gap-2">
              <Input
                value={binPath}
                onChange={(e) => setBinPath(e.target.value)}
                placeholder={binExample}
                className="font-mono text-[13px]"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setBrowseOpen(true)}
                className="shrink-0"
              >
                <FolderOpen size={16} /> Browse…
              </Button>
            </div>
            <span className="text-[12px] text-muted">
              Absolute path to the compiled{' '}
              <code className="font-mono">{isWin ? 'llama-server.exe' : 'llama-server'}</code>{' '}
              executable (from a llama.cpp build or release). Validated and probed when you
              add it.
            </span>
          </label>

          {error && <InlineError message={error} />}
        </div>

        <FsBrowser
          open={browseOpen}
          onOpenChange={setBrowseOpen}
          onSelect={(p) => {
            setBinPath(p)
            setError(null)
          }}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={add.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {add.isPending ? 'Probing…' : 'Add engine'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
