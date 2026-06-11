import { useState } from 'react'
import { Plus } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { useEngineMutations } from '../../lib/queries'
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

/** Add-engine dialog: name + absolute binPath. On success closes + refetches; on
 *  error (binary_not_found / probe_failed) shows error.message inline and stays
 *  open (spec 03 §9, brief). */
export function AddEngineDialog() {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [binPath, setBinPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { add } = useEngineMutations()

  const reset = () => {
    setName('')
    setBinPath('')
    setError(null)
  }

  const submit = () => {
    setError(null)
    add.mutate(
      { name: name.trim(), binPath: binPath.trim() },
      {
        onSuccess: () => {
          toast.success('Engine added')
          setOpen(false)
          reset()
        },
        onError: (e) => {
          setError(e instanceof ApiError ? e.message : 'Could not add engine.')
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
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink">Binary path</span>
            <Input
              value={binPath}
              onChange={(e) => setBinPath(e.target.value)}
              placeholder="C:\\path\\to\\llama-server.exe"
              className="font-mono text-[13px]"
            />
            <span className="text-[12px] text-muted">
              Paste the absolute path to the binary. It is validated and probed when you
              add it.
            </span>
          </label>

          {error && <InlineError message={error} />}
        </div>

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
