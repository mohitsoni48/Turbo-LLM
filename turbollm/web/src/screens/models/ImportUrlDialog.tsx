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

/** Convert non-standard HF URL forms to a direct https resolve URL.
 *  Handles hf://owner/repo/file.gguf and ?show_file_info=file.gguf page URLs.
 *  All other URLs are returned unchanged. */
function normalizeHfUrl(raw: string): string {
  try {
    if (raw.startsWith('hf://')) {
      const parts = raw.slice(5).split('/')
      if (parts.length >= 3 && parts[parts.length - 1].toLowerCase().endsWith('.gguf')) {
        const [owner, repo, ...rest] = parts
        return `https://huggingface.co/${owner}/${repo}/resolve/main/${rest.join('/')}`
      }
    }
    const u = new URL(raw)
    if (u.hostname === 'huggingface.co') {
      const file = u.searchParams.get('show_file_info')
      if (file && file.toLowerCase().endsWith('.gguf')) {
        return `https://huggingface.co${u.pathname}/resolve/main/${file}`
      }
    }
  } catch { /* ignore */ }
  return raw
}

export function ImportUrlDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const mut = useDownloadMutations()
  const [url, setUrl] = useState('')

  const trimmed = url.trim()
  const normalized = useMemo(() => normalizeHfUrl(trimmed), [trimmed])
  const wasNormalized = normalized !== trimmed
  const filename = useMemo(() => deriveFilename(normalized), [normalized])
  const valid = trimmed.length > 0 && isValidGgufUrl(normalized)
  const showInvalid = trimmed.length > 0 && !valid

  const enqueueErr = mut.enqueue.error instanceof ApiError ? mut.enqueue.error : null
  const enqueueError = enqueueErr?.message ?? null
  const noModelDir = enqueueErr?.code === 'no_model_dir'

  const close = () => {
    setUrl('')
    mut.enqueue.reset()
    onClose()
  }

  const submit = () => {
    if (!valid) return
    mut.enqueue.mutate(
      { url: normalized },
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
              {wasNormalized && (
                <p className="mt-1 text-faint">URL converted to a direct download link.</p>
              )}
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
          {noModelDir && (
            <p className="text-[12px] text-muted">
              → Open <span className="font-medium text-ink">Settings → Model folders</span> to add a folder, then try again.
            </p>
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
