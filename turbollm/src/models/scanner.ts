// Model discovery (A3, spec 04): scan model directories for GGUFs, parse their
// headers, group split/mmproj files, and expose a rich model list. Path-cached.
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { ConfigStore } from '../config/config'
import { GgufError, type GgufMeta, parseGguf, quantFromName } from '../gguf/gguf'

export interface ModelEntry {
  key: string
  name: string
  path: string
  dir: string
  sizeBytes: number
  sizeLabel: string
  arch: string
  quant: string
  nativeCtx: number
  blockCount: number
  moe: boolean
  expertCount: number
  vision: boolean
  mmprojPath: string | null
  hasChatTemplate: boolean
  incomplete: boolean
  parseError: string | null
  loaded: boolean
  hasProfile: boolean
  benchTps: number | null
  mtime: string
}

interface CacheRow {
  size: number
  mtime: number
  meta: GgufMeta
}

const SPLIT_RE = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/i

export class Scanner {
  private entries: ModelEntry[] = []
  private scanning = false
  private lastScanAt = ''
  private cache = new Map<string, CacheRow>()
  private cachePath: string

  constructor(private store: ConfigStore) {
    this.cachePath = join(store.dir(), 'models-cache.json')
    this.loadCache()
  }

  list(): { models: ModelEntry[]; scanning: boolean; lastScanAt: string } {
    return { models: this.entries, scanning: this.scanning, lastScanAt: this.lastScanAt }
  }

  get(key: string): ModelEntry | undefined {
    return this.entries.find((e) => e.key === key)
  }

  /** Re-scan all configured model directories. Coalesces concurrent calls. */
  async rescan(): Promise<void> {
    if (this.scanning) return
    this.scanning = true
    try {
      const dirs = this.store.snapshot().modelDirs
      const files: FileInfo[] = []
      for (const d of dirs) {
        if (existsSync(d)) walk(d, files)
        await tick()
      }
      this.entries = await this.build(files)
      this.lastScanAt = new Date().toISOString()
      this.saveCache()
    } finally {
      this.scanning = false
    }
  }

  private async build(files: FileInfo[]): Promise<ModelEntry[]> {
    // Group by directory for split + mmproj resolution (spec 04 §2).
    const byDir = new Map<string, FileInfo[]>()
    for (const f of files) {
      const d = dirname(f.path)
      ;(byDir.get(d) ?? byDir.set(d, []).get(d)!).push(f)
    }

    const entries: ModelEntry[] = []
    for (const [dir, group] of byDir) {
      const mmprojFiles = group.filter((f) => basename(f.path).toLowerCase().includes('mmproj'))
      const modelFiles = group.filter((f) => !basename(f.path).toLowerCase().includes('mmproj'))
      const mmprojPath = mmprojFiles.sort((a, b) => b.size - a.size)[0]?.path ?? null

      // Resolve split groups: prefix+total -> shards.
      const splits = new Map<string, { shards: FileInfo[]; total: number }>()
      const singles: FileInfo[] = []
      for (const f of modelFiles) {
        const m = basename(f.path).match(SPLIT_RE)
        if (m) {
          const gkey = `${m[1]}|${m[3]}`
          const g = splits.get(gkey) ?? { shards: [], total: Number(m[3]) }
          g.shards.push(f)
          splits.set(gkey, g)
        } else {
          singles.push(f)
        }
      }

      for (const f of singles) {
        entries.push(await this.entryFor(f.path, f.size, f.mtime, dir, mmprojPath, false))
        await tick()
      }
      for (const { shards, total } of splits.values()) {
        shards.sort((a, b) => a.path.localeCompare(b.path))
        const first = shards[0]
        const totalSize = shards.reduce((s, x) => s + x.size, 0)
        const incomplete = shards.length !== total
        entries.push(await this.entryFor(first.path, totalSize, first.mtime, dir, mmprojPath, incomplete))
        await tick()
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    return entries
  }

  private async entryFor(
    path: string,
    sizeBytes: number,
    mtimeMs: number,
    dir: string,
    mmprojPath: string | null,
    incomplete: boolean,
  ): Promise<ModelEntry> {
    let meta: GgufMeta | null = null
    let parseError: string | null = null

    const cached = this.cache.get(path)
    if (cached && cached.size === sizeBytes && cached.mtime === mtimeMs) {
      meta = cached.meta
    } else {
      try {
        meta = parseGguf(path)
        this.cache.set(path, { size: sizeBytes, mtime: mtimeMs, meta })
      } catch (e) {
        parseError = e instanceof GgufError ? e.message : (e as Error).message
      }
    }

    const fileName = basename(path)
    const quant = meta?.quant || quantFromName(fileName)
    const name = meta?.name || cleanName(fileName)
    const vision = mmprojPath !== null

    return {
      key: `${name.toLowerCase()}|${quant}|${sizeBytes}`,
      name,
      path,
      dir,
      sizeBytes,
      sizeLabel: meta?.sizeLabel ?? '',
      arch: meta?.arch ?? 'unknown',
      quant,
      nativeCtx: meta?.nativeCtx ?? 0,
      blockCount: meta?.blockCount ?? 0,
      moe: (meta?.expertCount ?? 0) > 0,
      expertCount: meta?.expertCount ?? 0,
      vision,
      mmprojPath: vision ? mmprojPath : null,
      hasChatTemplate: meta?.hasChatTemplate ?? false,
      incomplete,
      parseError,
      loaded: false, // overlaid live by the API layer
      hasProfile: false, // overlaid live by the API layer
      benchTps: null,
      mtime: new Date(mtimeMs).toISOString(),
    }
  }

  private loadCache(): void {
    try {
      const raw = JSON.parse(readFileSync(this.cachePath, 'utf8')) as { entries?: Record<string, CacheRow> }
      for (const [k, v] of Object.entries(raw.entries ?? {})) this.cache.set(k, v)
    } catch {
      /* no cache yet */
    }
  }

  private saveCache(): void {
    const entries: Record<string, CacheRow> = {}
    for (const [k, v] of this.cache) entries[k] = v
    try {
      writeFileSync(this.cachePath, JSON.stringify({ version: 1, entries }))
    } catch {
      /* cache is a pure accelerator */
    }
  }
}

interface FileInfo {
  path: string
  size: number
  mtime: number
}

function walk(dir: string, out: FileInfo[]): void {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return // permission / gone
  }
  for (const name of names) {
    if (name === '.git' || name === 'node_modules') continue
    const full = join(dir, name)
    let st
    try {
      st = lstatSync(full)
    } catch {
      continue
    }
    if (st.isSymbolicLink()) continue // avoid cycles
    if (st.isDirectory()) walk(full, out)
    else if (st.isFile() && name.toLowerCase().endsWith('.gguf') && st.size >= 1 << 20) {
      out.push({ path: full, size: st.size, mtime: st.mtimeMs })
    }
  }
}

function cleanName(fileName: string): string {
  return fileName
    .replace(/\.gguf$/i, '')
    .replace(/-\d{5}-of-\d{5}$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r))
}
