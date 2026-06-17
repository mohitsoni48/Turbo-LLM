// Hugging Face discovery client (spec 10 §1–4). Client↔HF direct (ADR-011): the
// daemon calls HF with the user's token; nothing routes through our infra. All
// GET responses are cached in-memory for 5 minutes (key = full URL) for graceful
// degradation. Network/auth failures surface as a typed HfError so routes can map
// them to a stable error envelope.
import { quantFromName } from '../gguf/gguf'

const BASE = 'https://huggingface.co'
const CACHE_TTL_MS = 5 * 60 * 1000

/** Carries a machine-checkable `code` for the API error envelope. */
export class HfError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HfError'
  }
}

/** A search result row (spec 10 §2). `localCount` is overlaid by the route layer
 *  from the scan cache — the client itself has no view of the local library. */
export interface HfSearchItem {
  repo: string
  downloads: number
  likes: number
  updatedAt: string
  gated: boolean
  tags: string[]
}

/** One logical file in a repo (spec 10 §3). For GGUF: split parts are grouped into
 *  a single entry with summed size and `parts` > 1. For safetensors repos (MLX /
 *  vLLM): each component file (safetensors + JSON) is its own entry with
 *  `safetensors: true`. */
export interface HfRepoFile {
  name: string
  quant: string
  sizeBytes: number
  parts: number
  mmproj: boolean
  /** True for safetensors component files (MLX and vLLM repos). */
  safetensors?: boolean
  /** HF LFS sha256 when published in the tree metadata; used for integrity. */
  sha256?: string
  /** Download URL for the first/only part (resolve/main). */
  url: string
}

export interface HfRepoDetail {
  repo: string
  gated: boolean
  license: string
  downloads: number
  likes: number
  card: string
  files: HfRepoFile[]
  /** True when the repo is a safetensors model (no GGUFs — covers MLX and vLLM). */
  safetensors?: boolean
}

interface CacheRow {
  at: number
  value: unknown
}

const SPLIT_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i

export class HfClient {
  private cache = new Map<string, CacheRow>()

  constructor(
    private tokenFn: () => string,
    private version: string,
  ) {}

  /** Search repos (spec 10 §2). Returns up to 30 rows sorted by downloads.
   *  Format filter adapts to the active engine kind:
   *  - llama-server / TurboQuant → filter=gguf
   *  - mlx                       → filter=mlx (HF library tag)
   *  - vllm                      → no format filter (searches all HF repos) */
  async searchModels(query: string, engineKind?: string): Promise<HfSearchItem[]> {
    const q = query.trim()
    const formatFilter =
      engineKind === 'mlx' ? '&filter=mlx' : engineKind === 'vllm' ? '' : '&filter=gguf'
    const url =
      `${BASE}/api/models?search=${encodeURIComponent(q)}` +
      `${formatFilter}&sort=downloads&direction=-1&limit=30&full=false`
    const raw = await this.getJson<RawSearchItem[]>(url)
    return raw.map((m) => ({
      repo: m.id ?? m.modelId ?? '',
      downloads: m.downloads ?? 0,
      likes: m.likes ?? 0,
      updatedAt: m.lastModified ?? m.createdAt ?? '',
      gated: m.gated === true || m.gated === 'auto' || m.gated === 'manual',
      tags: Array.isArray(m.tags) ? m.tags : [],
    }))
  }

  /** Repo detail (spec 10 §3): card data + the GGUF file tree, with split parts
   *  grouped and quant/mmproj detected per file. */
  async getRepo(repo: string): Promise<HfRepoDetail> {
    const info = await this.getJson<RawRepoInfo>(`${BASE}/api/models/${repo}`)
    const tree = await this.getJson<RawTreeEntry[]>(`${BASE}/api/models/${repo}/tree/main?recursive=true`)

    const ggufEntries = tree.filter((e) => e.type === 'file' && /\.gguf$/i.test(e.path))
    const safetensorsEntries = tree.filter((e) => e.type === 'file' && /\.safetensors$/i.test(e.path))

    // Safetensors repo (MLX or vLLM): has safetensors weights but no GGUFs.
    const isSafetensors = ggufEntries.length === 0 && safetensorsEntries.length > 0

    let files: HfRepoFile[]
    let safetensors: boolean | undefined
    if (isSafetensors) {
      safetensors = true
      // Collect all component files: safetensors weights + JSON config/tokenizer files.
      const components = tree.filter(
        (e) =>
          e.type === 'file' &&
          (/\.safetensors$/i.test(e.path) || /\.json$/i.test(e.path)) &&
          !e.path.includes('/'), // root-level only — no nested model card assets
      )
      files = components.map((e) => ({
        name: e.path,
        quant: 'mlx',
        sizeBytes: e.lfs?.size ?? e.size ?? 0,
        parts: 1,
        mmproj: false,
        safetensors: true,
        sha256: e.lfs?.oid,
        url: this.fileUrl(repo, e.path),
      }))
    } else {
      files = groupFiles(repo, ggufEntries)
    }

    const gated = info.gated === true || info.gated === 'auto' || info.gated === 'manual'
    const license =
      info.cardData?.license ??
      (info.tags?.find((t) => t.startsWith('license:'))?.slice('license:'.length) || '')

    return {
      repo,
      gated,
      license: typeof license === 'string' ? license : '',
      downloads: info.downloads ?? 0,
      likes: info.likes ?? 0,
      card: await this.getCard(repo),
      files,
      ...(safetensors ? { safetensors } : {}),
    }
  }

  /** Fetch the repo README (the model card), strip its YAML frontmatter, and cap the
   *  length for display. Best-effort — a missing/unreachable README yields '' rather
   *  than failing the whole repo-detail request. Cached like other HF reads. */
  private async getCard(repo: string): Promise<string> {
    const url = `${BASE}/${repo}/raw/main/README.md`
    const now = Date.now()
    const hit = this.cache.get(url)
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.value as string
    try {
      const res = await fetch(url, { headers: this.authHeaders(), redirect: 'follow' })
      if (!res.ok) return ''
      const raw = await res.text()
      // Strip a leading `---\n…\n---` YAML frontmatter block, then cap the size.
      const body = raw.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
      const card = body.slice(0, 12000)
      this.cache.set(url, { at: now, value: card })
      return card
    } catch {
      return ''
    }
  }

  /** Validate a token against HF whoami (spec 10 §4). Never throws on a bad token —
   *  returns { ok:false } so the Settings "Test" button can show a clean failure. */
  async testToken(token: string): Promise<{ ok: boolean; name?: string }> {
    const t = token.trim()
    if (!t) return { ok: false }
    let res: Response
    try {
      res = await fetch(`${BASE}/api/whoami-v2`, {
        headers: { Authorization: `Bearer ${t}`, 'User-Agent': `TurboLLM/${this.version}` },
      })
    } catch {
      throw new HfError('hf_unreachable', 'Hugging Face is unreachable — check your connection.')
    }
    if (!res.ok) return { ok: false }
    const who = (await res.json().catch(() => ({}))) as { name?: string; fullname?: string }
    return { ok: true, name: who.name ?? who.fullname }
  }

  /** Build the resolve URL for a repo file (spec 10 §1). */
  fileUrl(repo: string, rfilename: string): string {
    return `${BASE}/${repo}/resolve/main/${rfilename}`
  }

  /** Authorization header when a token is configured (for gated repos). */
  authHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'User-Agent': `TurboLLM/${this.version}` }
    const t = this.tokenFn().trim()
    if (t) headers.Authorization = `Bearer ${t}`
    return headers
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async getJson<T>(url: string): Promise<T> {
    const now = Date.now()
    const hit = this.cache.get(url)
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.value as T

    let res: Response
    try {
      res = await fetch(url, { headers: this.authHeaders(), redirect: 'follow' })
    } catch {
      // Graceful degradation: serve a stale cache entry if we have one.
      if (hit) return hit.value as T
      throw new HfError('hf_unreachable', 'Hugging Face is unreachable — check your connection.')
    }
    if (res.status === 403) {
      throw new HfError('hf_gated', 'This repository is gated — accept its license on huggingface.co and add your token.')
    }
    if (res.status === 401) {
      // HF returns 401 for a private OR non-existent repo when no token is sent.
      // Only a configured-but-rejected token is a real auth failure; otherwise this
      // is effectively "not found" (commonly a model folder name that doesn't match
      // its actual HF repo id).
      if (this.tokenFn().trim()) throw new HfError('hf_unauthorized', 'Your Hugging Face token was rejected.')
      throw new HfError('hf_not_found', 'Not found on Hugging Face — it may be private, or the name may not match its repo.')
    }
    if (res.status === 404) {
      throw new HfError('hf_not_found', 'This model was not found on Hugging Face.')
    }
    if (!res.ok) {
      // 5xx / 429 / anything else: a transient server-side problem, not "your repo".
      if (hit) return hit.value as T
      throw new HfError('hf_unreachable', `Hugging Face request failed (HTTP ${res.status}).`)
    }
    const value = (await res.json()) as T
    this.cache.set(url, { at: now, value })
    return value
  }
}

// ── tree → logical files ───────────────────────────────────────────────────

interface RawSearchItem {
  id?: string
  modelId?: string
  downloads?: number
  likes?: number
  lastModified?: string
  createdAt?: string
  gated?: boolean | string
  tags?: string[]
}

interface RawRepoInfo {
  downloads?: number
  likes?: number
  gated?: boolean | string
  tags?: string[]
  cardData?: { license?: string }
}

interface RawTreeEntry {
  type?: string
  path: string
  size?: number
  lfs?: { oid?: string; size?: number }
}

/** Group raw GGUF tree entries into logical files: split parts (NNNNN-of-NNNNN)
 *  collapse into one entry with summed size and parts>1; everything else is a
 *  single-part file. mmproj projectors are flagged separately (spec 10 §3). */
function groupFiles(repo: string, entries: RawTreeEntry[]): HfRepoFile[] {
  const splits = new Map<string, { parts: RawTreeEntry[]; total: number }>()
  const singles: RawTreeEntry[] = []
  for (const e of entries) {
    const m = base(e.path).match(SPLIT_RE)
    if (m) {
      const gkey = `${m[1]}|${m[3]}`
      const g = splits.get(gkey) ?? { parts: [], total: Number(m[3]) }
      g.parts.push(e)
      splits.set(gkey, g)
    } else {
      singles.push(e)
    }
  }

  const out: HfRepoFile[] = []
  for (const e of singles) out.push(fileFor(repo, e, base(e.path), 1))
  for (const { parts, total } of splits.values()) {
    parts.sort((a, b) => a.path.localeCompare(b.path))
    const first = parts[0]
    const size = parts.reduce((s, p) => s + sizeOf(p), 0)
    out.push(fileFor(repo, first, base(first.path), total, size))
  }
  // Recommended-first ordering is the UI's job; keep a stable name sort here.
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function fileFor(
  repo: string,
  e: RawTreeEntry,
  name: string,
  parts: number,
  sizeOverride?: number,
): HfRepoFile {
  const mmproj = name.toLowerCase().includes('mmproj')
  return {
    name,
    quant: mmproj ? 'mmproj' : quantFromName(name),
    sizeBytes: sizeOverride ?? sizeOf(e),
    parts,
    mmproj,
    sha256: e.lfs?.oid,
    url: `${BASE}/${repo}/resolve/main/${e.path}`,
  }
}

function sizeOf(e: RawTreeEntry): number {
  return e.lfs?.size ?? e.size ?? 0
}

function base(p: string): string {
  const i = p.lastIndexOf('/')
  return i >= 0 ? p.slice(i + 1) : p
}
