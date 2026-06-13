// Import-from-URL dialog (spec 10 §8). A URL field with a live filename preview;
// client-side validation that the URL looks like a direct .gguf or an HF resolve
// blob URL; on submit it enqueues a raw-URL download via useDownloadMutations and
// closes — the item then appears in the DownloadsPanel.

import { useMemo, useState } from 'react'
import { Link2 } from 'lucide-react'
import { ApiError } from '../../lib/api'
import { useDownloadMutations } from '../../lib/queries'
import { Button } from '../../components/ui/button'
import { Input } from '../../components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog'

/** True when the URL is a plausible GGUF download target (spec 10 §8 step 2):
 *  path ends in `.gguf` OR matches an HF resolve blob URL. */
function isValidGgufUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  const path = u.pathname.toLowerCase()
  if (path.endsWith('.gguf')) return true
  // HF blob URL: huggingface.co/<repo>/resolve/<rev>/<file>.gguf
  return /huggingface\.co\/.*\/resolve\/.*\.gguf$/i.test(`${u.host}${u.pathname}`)
}

/** Derived filename from the URL path (spec 10 §8: filename preview). */
function deriveFilename(raw: string): string {
  try {
    const u = new URL(raw)
    const last = u.pathname.split('/').filter(Boolean).pop() ?? ''
    return decodeURIComponent(last)
  } catch {
    return ''
  }
}

export function ImportUrlDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mut = useDownloadMutations()
  const [url, setUrl] = useState('')

  const trimmed = url.trim()
  const filename = useMemo(() => deriveFilename(trimmed), [trimmed])
  const valid = trimmed.length > 0 && isValidGgufUrl(trimmed)
  const showInvalid = trimmed.length > 0 && !valid

  const enqueueError = mut.enqueue.error instanceof ApiError ? mut.enqueue.error.message : null

  const close = () => {
    setUrl('')
    mut.enqueue.reset()
    onClose()
  }

  const submit = () => {
    if (!valid) return
    mut.enqueue.mutate(
      { url: trimmed },
      {
        onSuccess: () => close(),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Import from URL</DialogTitle>
          <DialogDescription>
            Paste a direct link to a <span className="font-mono">.gguf</span> file — any HTTPS host, not just Hugging Face.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="https://huggingface.co/owner/repo/resolve/main/model.Q4_K_M.gguf"
            className="font-mono text-[12px]"
          />

          {filename && valid && (
            <div className="rounded-md border border-border bg-panel-2 px-3 py-2 text-[12px]">
              <span className="text-muted">Will save as </span>
              <span className="font-mono text-ink">{filename}</span>
            </div>
          )}

          {showInvalid && (
            <p className="text-[12px]" style={{ color: 'var(--err)' }}>
              Enter a valid http(s) link ending in <span className="font-mono">.gguf</span> (or an HF resolve URL).
            </p>
          )}

          {enqueueError && (
            <p className="text-[12px]" style={{ color: 'var(--err)' }}>{enqueueError}</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close}>Cancel</Button>
          <Button onClick={submit} disabled={!valid || mut.enqueue.isPending}>
            <Link2 size={14} />
            {mut.enqueue.isPending ? 'Adding…' : 'Import'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
