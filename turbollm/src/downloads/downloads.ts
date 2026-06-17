// Download manager (spec 10 §5–6, §8). Streams GGUF files from Hugging Face or an
// arbitrary HTTP(S) URL into the effective primaryModelDir, with single-connection
// resume (.part + Range), max 2 concurrent, disk-space pre-check, manifest
// persistence across daemon restarts, and a scan trigger on completion. Fail-safe:
// a failed job sets status='error' with a message and never crashes the daemon.
import { createHash } from 'node:crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ConfigStore } from '../config/config'

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'done' | 'error' | 'cancelled'

export interface DownloadRecord {
  id: string
  /** Display name = the destination filename. */
  name: string
  /** Source HF repo ("owner/name"), or '' for a raw-URL import. */
  repo: string
  url: string
  dest: string
  total: number
  received: number
  status: DownloadStatus
  error: string | null
  /** Best-effort instantaneous bytes/sec, updated while downloading. */
  bytesPerSec: number
  /** HF LFS sha256 to verify against when known (spec 10 §5). */
  sha256?: string
  createdAt: string
}

/** Persisted manifest shape (spec 10 §5). Live runtime fields (controller, timers)
 *  are not persisted — restored jobs come back as 'paused'. */
interface ManifestEntry {
  id: string
  name: string
  repo: string
  url: string
  dest: string
  total: number
  sha256?: string
  createdAt: string
}

/** Download provenance: a record of which HF repo + file a local model came from,
 *  kept permanently (the manifest drops completed jobs). Lets the Discover UI mark a
 *  quant "Downloaded" only for the SPECIFIC repo it was pulled from — the identical
 *  model+quant from a different repo (a different requant, different sha256) is
 *  correctly shown as not-downloaded. Keyed primarily by sha256 (exact file
 *  identity), with (repo, filename) as the fallback when no hash is known. */
export interface ProvenanceEntry {
  repo: string
  filename: string
  sha256?: string
  dest: string
  at: string
}

const MAX_CONCURRENT = 2
const HF_BLOB_RE = /^https?:\/\/huggingface\.co\/.+\/resolve\/.+\.gguf$/i

export interface EnqueueInput {
  repo?: string
  rfilename?: string
  url?: string
  size?: number
  sha256?: string
  /** Subdirectory under the primary model dir for the downloaded file. Used for
   *  MLX models whose component files must all land in the same directory. */
  subdir?: string
}

export class DownloadError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'DownloadError'
  }
}

export class DownloadManager {
  private records = new Map<string, DownloadRecord>()
  private controllers = new Map<string, AbortController>()
  private manifestPath: string
  private provenancePath: string
  private provenanceList: ProvenanceEntry[] = []
  private nextSeq = 0

  constructor(
    private store: ConfigStore,
    /** Called after a download completes so the model list picks up the new file. */
    private onComplete: () => void,
    private authHeaders: () => Record<string, string>,
  ) {
    const dir = join(store.dir(), 'downloads')
    mkdirSync(dir, { recursive: true })
    this.manifestPath = join(dir, 'manifest.json')
    this.provenancePath = join(dir, 'provenance.json')
    this.restore()
    this.loadProvenance()
  }

  /** Permanent record of which repo+file each downloaded model came from (spec 10 §3).
   *  Consumed by the repo-detail route to mark a quant "Downloaded" for the exact repo
   *  it was pulled from. */
  provenance(): ProvenanceEntry[] {
    return [...this.provenanceList]
  }

  /** Active (downloading) job count — surfaced on GET /status. */
  activeCount(): number {
    let n = 0
    for (const r of this.records.values()) if (r.status === 'downloading') n++
    return n
  }

  list(): DownloadRecord[] {
    return [...this.records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Enqueue a download. Validates the target + disk space, persists, then kicks
   *  the queue. Throws DownloadError for caller-actionable failures (no dir set,
   *  bad URL, insufficient disk). */
  enqueue(input: EnqueueInput): DownloadRecord {
    const dir = this.primaryDir()
    if (!dir) throw new DownloadError('no_model_dir', 'Add a model folder in Settings before downloading.')

    let repo = (input.repo ?? '').trim()
    const subdir = (input.subdir ?? '').trim()
    let url: string
    let filename: string
    if (input.url) {
      const u = input.url.trim()
      if (!/^https?:\/\//i.test(u)) throw new DownloadError('invalid_url', 'URL must start with http:// or https://.')
      const path = safePathname(u)
      if (!subdir && !/\.gguf$/i.test(path) && !HF_BLOB_RE.test(u)) {
        throw new DownloadError('invalid_url', 'URL must point to a .gguf file.')
      }
      filename = basename(path)
      if (!subdir && !/\.gguf$/i.test(filename)) throw new DownloadError('invalid_url', 'Could not derive a .gguf filename from that URL.')
      url = u
      repo = '' // raw-URL import: no provenance
    } else {
      const rfilename = (input.rfilename ?? '').trim()
      if (!repo || !rfilename) throw new DownloadError('invalid_request', 'repo and rfilename are required.')
      if (!subdir && !/\.gguf$/i.test(rfilename)) throw new DownloadError('invalid_url', 'The file must be a .gguf.')
      filename = basename(rfilename)
      url = `https://huggingface.co/${repo}/resolve/main/${rfilename}`
    }

    const total = input.size ?? 0
    const destDir = subdir ? join(dir, subdir) : dir
    if (subdir) mkdirSync(destDir, { recursive: true })
    if (total > 0) this.assertDisk(dir, total)

    const id = `dl-${Date.now().toString(36)}-${(this.nextSeq++).toString(36)}`
    const rec: DownloadRecord = {
      id,
      name: filename,
      repo,
      url,
      dest: join(destDir, filename),
      total,
      received: 0,
      status: 'queued',
      error: null,
      bytesPerSec: 0,
      sha256: input.sha256,
      createdAt: new Date().toISOString(),
    }
    this.records.set(id, rec)
    this.persist()
    this.pump()
    return rec
  }

  /** Cancel an in-flight or queued job: abort the stream, delete the .part, mark
   *  cancelled. Keeps the record so the UI can show + clear it. */
  cancel(id: string): boolean {
    const rec = this.records.get(id)
    if (!rec) return false
    this.controllers.get(id)?.abort()
    this.controllers.delete(id)
    if (rec.status !== 'done') {
      rmSync(`${rec.dest}.part`, { force: true })
      rec.status = 'cancelled'
      rec.bytesPerSec = 0
    }
    this.persist()
    this.pump()
    return true
  }

  /** Remove a record entirely (and any lingering .part). */
  remove(id: string): boolean {
    const rec = this.records.get(id)
    if (!rec) return false
    this.controllers.get(id)?.abort()
    this.controllers.delete(id)
    if (rec.status !== 'done') rmSync(`${rec.dest}.part`, { force: true })
    this.records.delete(id)
    this.persist()
    this.pump()
    return true
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Effective primary download dir (spec 01 §3, ADR-035): the configured primary
   *  when still valid, else the first modelDir; '' when none configured. Mirrors
   *  the /modeldirs endpoint's resolution. */
  private primaryDir(): string {
    const cfg = this.store.snapshot()
    return cfg.primaryModelDir && cfg.modelDirs.includes(cfg.primaryModelDir)
      ? cfg.primaryModelDir
      : (cfg.modelDirs[0] ?? '')
  }

  /** Disk-space guard (spec 10 §6): require free ≥ size × 1.1. Best-effort — skips
   *  the check (does not block) when free space can't be determined. */
  private assertDisk(dir: string, size: number): void {
    let free: number
    try {
      const st = statfsSync(dir)
      free = st.bavail * st.bsize
    } catch {
      return // can't measure → don't block
    }
    const need = size * 1.1
    if (free < need) {
      throw new DownloadError(
        'insufficient_disk',
        `Not enough free disk space: need ~${gb(need)} GB, only ${gb(free)} GB free.`,
      )
    }
  }

  /** Start queued jobs up to the concurrency cap. */
  private pump(): void {
    if (this.activeCount() >= MAX_CONCURRENT) return
    for (const rec of this.list()) {
      if (this.activeCount() >= MAX_CONCURRENT) break
      if (rec.status === 'queued') void this.run(rec)
    }
  }

  private async run(rec: DownloadRecord): Promise<void> {
    rec.status = 'downloading'
    rec.error = null
    const ac = new AbortController()
    this.controllers.set(rec.id, ac)
    const part = `${rec.dest}.part`

    try {
      // Resume from an existing .part via a Range request (spec 10 §5).
      let startAt = 0
      if (existsSync(part)) {
        try {
          startAt = statSync(part).size
        } catch {
          startAt = 0
        }
      }
      rec.received = startAt

      const headers: Record<string, string> = { ...this.authHeaders() }
      if (startAt > 0) headers.Range = `bytes=${startAt}-`

      const res = await fetch(rec.url, { headers, redirect: 'follow', signal: ac.signal })
      if (res.status === 401) throw new DownloadError('hf_unauthorized', 'Your Hugging Face token was rejected.')
      if (res.status === 403) throw new DownloadError('hf_gated', 'This repository is gated — accept its license and add your token.')
      if (!res.ok && res.status !== 206) throw new DownloadError('download_failed', `Download failed (HTTP ${res.status}).`)
      if (!res.body) throw new DownloadError('download_failed', 'Empty response body.')

      // A 200 (not 206) means the server ignored Range → restart from scratch.
      const resuming = res.status === 206
      if (!resuming && startAt > 0) {
        rmSync(part, { force: true })
        startAt = 0
        rec.received = 0
      }

      const clen = Number(res.headers.get('content-length') ?? 0)
      if (clen > 0) rec.total = resuming ? startAt + clen : clen

      const hash = rec.sha256 ? createHash('sha256') : null
      // sha256 can only be verified over the full file; skip it on a partial resume.
      const verifyHash = hash !== null && startAt === 0

      let lastTick = Date.now()
      let lastBytes = startAt
      const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
      body.on('data', (chunk: Buffer) => {
        rec.received += chunk.length
        if (verifyHash) hash!.update(chunk)
        const now = Date.now()
        const dt = now - lastTick
        if (dt >= 500) {
          rec.bytesPerSec = ((rec.received - lastBytes) / dt) * 1000
          lastTick = now
          lastBytes = rec.received
        }
      })

      const out = createWriteStream(part, startAt > 0 ? { flags: 'a' } : { flags: 'w' })
      await pipeline(body, out, { signal: ac.signal })

      // Integrity: size (spec 10 §5/§8) + sha256 when fully streamed.
      if (rec.total > 0 && rec.received !== rec.total) {
        rmSync(part, { force: true })
        throw new DownloadError('size_mismatch', 'Download corrupt — size did not match. Removed the partial file.')
      }
      if (verifyHash && rec.sha256) {
        const got = hash!.digest('hex')
        if (got !== rec.sha256) {
          rmSync(part, { force: true })
          throw new DownloadError('checksum_failed', 'Checksum failed — the downloaded file was corrupt.')
        }
      }

      renameSync(part, rec.dest) // atomic within the same dir
      rec.status = 'done'
      rec.bytesPerSec = 0
      this.controllers.delete(rec.id)
      this.recordProvenance(rec)
      this.persist()
      try {
        this.onComplete()
      } catch {
        /* scan trigger is best-effort */
      }
    } catch (e) {
      this.controllers.delete(rec.id)
      rec.bytesPerSec = 0
      // A user cancel/remove already set a terminal status (and may have dropped the
      // record) — never clobber it back to 'error'. Aborts land here too.
      const terminal: DownloadStatus[] = ['cancelled', 'done']
      if (terminal.includes(rec.status) || (e as Error)?.name === 'AbortError') {
        if (rec.status !== 'done') rec.status = 'cancelled'
      } else {
        rec.status = 'error'
        rec.error = e instanceof Error ? e.message : String(e)
      }
      this.persist()
    } finally {
      this.pump()
    }
  }

  /** Append a completed download to the permanent provenance list, keyed by dest
   *  (re-downloading the same target replaces the old entry). Raw-URL imports carry
   *  an empty repo and so only ever match by sha256. */
  private recordProvenance(rec: DownloadRecord): void {
    const entry: ProvenanceEntry = {
      repo: rec.repo,
      filename: rec.name,
      sha256: rec.sha256,
      dest: rec.dest,
      at: new Date().toISOString(),
    }
    this.provenanceList = this.provenanceList.filter((p) => p.dest !== rec.dest)
    this.provenanceList.push(entry)
    this.saveProvenance()
  }

  private loadProvenance(): void {
    try {
      const parsed = JSON.parse(readFileSync(this.provenancePath, 'utf8')) as { entries?: ProvenanceEntry[] }
      this.provenanceList = parsed.entries ?? []
    } catch {
      /* no provenance yet */
    }
  }

  private saveProvenance(): void {
    try {
      writeFileSync(this.provenancePath, JSON.stringify({ version: 1, entries: this.provenanceList }, null, 2))
    } catch {
      /* provenance is a convenience — never fatal */
    }
  }

  /** Write the in-flight/queued manifest so jobs survive a daemon restart. Done
   *  rows are dropped from the manifest (the file is on disk and scanned). */
  private persist(): void {
    const entries: ManifestEntry[] = []
    for (const r of this.records.values()) {
      if (r.status === 'done' || r.status === 'cancelled') continue
      entries.push({
        id: r.id,
        name: r.name,
        repo: r.repo,
        url: r.url,
        dest: r.dest,
        total: r.total,
        sha256: r.sha256,
        createdAt: r.createdAt,
      })
    }
    try {
      writeFileSync(this.manifestPath, JSON.stringify({ version: 1, entries }, null, 2))
    } catch {
      /* manifest is a convenience — never fatal */
    }
  }

  /** Restore queued/in-flight jobs from a prior run as 'paused' (spec 10 §5): the
   *  user resumes manually. The .part offset (if any) lets a resume continue. */
  private restore(): void {
    let parsed: { entries?: ManifestEntry[] }
    try {
      parsed = JSON.parse(readFileSync(this.manifestPath, 'utf8')) as { entries?: ManifestEntry[] }
    } catch {
      return
    }
    for (const e of parsed.entries ?? []) {
      let received = 0
      try {
        const p = `${e.dest}.part`
        if (existsSync(p)) received = statSync(p).size
      } catch {
        /* ignore */
      }
      this.records.set(e.id, {
        id: e.id,
        name: e.name,
        repo: e.repo,
        url: e.url,
        dest: e.dest,
        total: e.total,
        received,
        status: 'paused',
        error: null,
        bytesPerSec: 0,
        sha256: e.sha256,
        createdAt: e.createdAt,
      })
    }
  }
}

function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(1)
}

/** Extract the URL pathname without throwing on a malformed URL. */
function safePathname(u: string): string {
  try {
    return new URL(u).pathname
  } catch {
    return ''
  }
}
