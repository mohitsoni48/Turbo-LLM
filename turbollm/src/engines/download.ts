// Default-engine provisioning (ADR-024 + ADR-025). On first run, download the
// official upstream llama.cpp prebuilt for the user's OS/arch + the **fastest
// backend their GPU supports** from GitHub Releases (ggml-org/llama.cpp) into
// the app-data engines dir. No bundling, no system paths, dependency-free
// (Node fetch; PowerShell Expand-Archive / tar for extraction). The user can
// override the backend; we fall back GPU → Vulkan → CPU if a build won't run.
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import type { GpuVendor } from '../sysinfo/sysinfo'

const execFileP = promisify(execFile)

// Pinned known-good upstream build. Bump deliberately after testing.
export const LLAMA_BUILD = 'b9608'
const REPO = 'ggml-org/llama.cpp'
// CUDA toolkit line for Windows prebuilts (13.x is required for Blackwell / RTX 50xx).
const CUDA_VER = '13.3'

const serverBin = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'

export type BackendId = 'cuda' | 'rocm' | 'sycl' | 'vulkan' | 'metal' | 'cpu'

export interface BackendDef {
  id: BackendId
  label: string
  /** Archives to download + extract into the same dir (main binary first). */
  assets: string[]
}

const plat = () => process.platform
const arch = () => (process.arch === 'arm64' ? 'arm64' : 'x64')

/** Every backend with a usable upstream prebuilt for this OS/arch, GPU-first. */
export function availableBackends(tag = LLAMA_BUILD): BackendDef[] {
  const a = arch()
  const def = (id: BackendId, label: string, ...assets: string[]): BackendDef => ({ id, label, assets })

  if (plat() === 'darwin') {
    return [def('metal', 'Metal (Apple GPU)', `llama-${tag}-bin-macos-${a}.tar.gz`)]
  }
  if (plat() === 'win32') {
    if (a === 'arm64') return [def('cpu', 'CPU', `llama-${tag}-bin-win-cpu-arm64.zip`)]
    return [
      def('cuda', 'CUDA (NVIDIA)', `llama-${tag}-bin-win-cuda-${CUDA_VER}-x64.zip`, `cudart-llama-bin-win-cuda-${CUDA_VER}-x64.zip`),
      def('rocm', 'ROCm / HIP (AMD Radeon)', `llama-${tag}-bin-win-hip-radeon-x64.zip`),
      def('sycl', 'SYCL (Intel)', `llama-${tag}-bin-win-sycl-x64.zip`),
      def('vulkan', 'Vulkan (any GPU)', `llama-${tag}-bin-win-vulkan-x64.zip`),
      def('cpu', 'CPU', `llama-${tag}-bin-win-cpu-x64.zip`),
    ]
  }
  if (plat() === 'linux') {
    // NOTE: upstream ships NO Linux CUDA prebuilt — NVIDIA on Linux uses Vulkan
    // (or a bring-your-own CUDA build).
    const list = [
      def('rocm', 'ROCm (AMD)', `llama-${tag}-bin-ubuntu-rocm-7.2-${a}.tar.gz`),
      def('sycl', 'SYCL (Intel)', `llama-${tag}-bin-ubuntu-sycl-fp16-${a}.tar.gz`),
      def('vulkan', 'Vulkan (any GPU)', `llama-${tag}-bin-ubuntu-vulkan-${a}.tar.gz`),
      def('cpu', 'CPU', `llama-${tag}-bin-ubuntu-${a}.tar.gz`),
    ]
    // ROCm/SYCL only ship x64; drop them on arm64.
    return a === 'arm64' ? list.filter((b) => b.id === 'vulkan' || b.id === 'cpu') : list
  }
  throw new Error(`unsupported platform: ${plat()}/${process.arch}`)
}

/** The fastest backend for the detected GPU vendor. */
export function recommendBackendId(vendor: GpuVendor, hasGpu: boolean, tag = LLAMA_BUILD): BackendId {
  const ids = new Set(availableBackends(tag).map((b) => b.id))
  if (plat() === 'darwin') return 'metal'
  if (!hasGpu) return 'cpu'
  let pick: BackendId
  switch (vendor) {
    case 'nvidia':
      pick = ids.has('cuda') ? 'cuda' : 'vulkan' // no Linux CUDA prebuilt
      break
    case 'amd':
      pick = ids.has('rocm') ? 'rocm' : 'vulkan'
      break
    case 'intel':
      pick = ids.has('sycl') ? 'sycl' : 'vulkan'
      break
    default:
      pick = 'vulkan'
  }
  return ids.has(pick) ? pick : 'cpu'
}

/** Ordered provisioning attempts: preferred backend, then Vulkan, then CPU. */
export function fallbackChain(preferred: BackendId, tag = LLAMA_BUILD): BackendDef[] {
  const all = availableBackends(tag)
  const order: BackendId[] = [preferred, 'vulkan', 'cpu']
  const out: BackendDef[] = []
  const seen = new Set<BackendId>()
  for (const id of order) {
    if (seen.has(id)) continue
    const def = all.find((b) => b.id === id)
    if (def) {
      out.push(def)
      seen.add(id)
    }
  }
  return out
}

export function backendDir(enginesRoot: string, id: BackendId, tag = LLAMA_BUILD): string {
  return join(enginesRoot, `llama.cpp-${tag}-${id}`)
}

/** Path to an already-extracted backend's server binary, or null if not installed. */
export function installedBackendServer(enginesRoot: string, id: BackendId, tag = LLAMA_BUILD): string | null {
  const dir = backendDir(enginesRoot, id, tag)
  return existsSync(dir) ? findServer(dir) : null
}

/** Recursively find a file by exact name under dir (first match), or null. */
export function findFile(dir: string, name: string): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      const r = findFile(full, name)
      if (r) return r
    } else if (e.name === name) {
      return full
    }
  }
  return null
}

function findServer(dir: string): string | null {
  return findFile(dir, serverBin)
}

export interface ProvisionProgress {
  phase: 'downloading' | 'extracting'
  pct: number // 0..1 while downloading; -1 = indeterminate (extracting)
  part?: number // 1-based archive index (multi-asset backends like CUDA)
  parts?: number // total archives for this backend
}

export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow', signal })
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let got = 0
  let lastPct = -1
  const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  body.on('data', (chunk: Buffer) => {
    got += chunk.length
    if (total && onProgress) {
      const pct = got / total
      if (pct - lastPct >= 0.05) {
        lastPct = pct
        onProgress({ phase: 'downloading', pct })
      }
    }
  })
  await pipeline(body, createWriteStream(dest), { signal })
}

/**
 * Extract an archive into destDir. Windows assets are .zip → PowerShell
 * Expand-Archive (always present, doesn't depend on which `tar` is on PATH).
 * macOS/Linux assets are .tar.gz → `tar -xzf`.
 */
export async function extractArchive(archive: string, destDir: string): Promise<void> {
  if (process.platform === 'win32') {
    const ps = `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`
    await execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { maxBuffer: 16 * 1024 * 1024 })
  } else {
    await execFileP('tar', ['-xzf', archive, '-C', destDir])
  }
}

/**
 * Ensure a backend is downloaded + extracted; return the llama-server path.
 * Multi-asset backends (CUDA = binary + cudart) extract into the same dir so the
 * runtime DLLs sit beside the server binary.
 */
export async function provisionBackend(
  enginesRoot: string,
  backend: BackendDef,
  tag: string,
  onProgress?: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const destDir = join(enginesRoot, `llama.cpp-${tag}-${backend.id}`)

  if (existsSync(destDir)) {
    const found = findServer(destDir)
    if (found) return found
  }

  mkdirSync(destDir, { recursive: true })
  const parts = backend.assets.length
  try {
    for (let i = 0; i < parts; i++) {
      const asset = backend.assets[i]
      const part = i + 1
      const tmp = join(enginesRoot, asset)
      const url = `https://github.com/${REPO}/releases/download/${tag}/${asset}`
      onProgress?.({ phase: 'downloading', pct: 0, part, parts })
      await downloadFile(url, tmp, (p) => onProgress?.({ ...p, part, parts }), signal)
      onProgress?.({ phase: 'extracting', pct: -1, part, parts })
      await extractArchive(tmp, destDir)
      rmSync(tmp, { force: true })
    }
  } catch (e) {
    // Cancelled or failed mid-download: remove partial archives + the half-built
    // backend dir so it isn't mistaken for an installed backend.
    for (const asset of backend.assets) rmSync(join(enginesRoot, asset), { force: true })
    rmSync(destDir, { recursive: true, force: true })
    throw e
  }

  const bin = findServer(destDir)
  if (!bin) throw new Error('llama-server not found in extracted archive(s)')
  return bin
}

/** Remove an installed backend's extracted files. Returns true if anything existed. */
export function deleteBackend(enginesRoot: string, id: BackendId, tag = LLAMA_BUILD): boolean {
  const dir = backendDir(enginesRoot, id, tag)
  if (!existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}

// ─── Generic fork provisioning from a GitHub release (ADR-044) ──────────────
// Catalog forks (e.g. TurboQuant) ship prebuilt `llama-server` binaries on their
// own GitHub Releases. We resolve the latest release at install time, pick the
// asset matching this OS/arch, then download + extract + locate the server — the
// same pipeline as the official backends, but pointed at an arbitrary repo with
// arbitrary asset names (so it survives the fork renaming its archives).

export interface ReleaseAsset {
  name: string
  browser_download_url: string
}

/** Score how well an asset name matches this OS/arch; -1 = no match (wrong OS/arch
 *  or not an archive). Higher is better — used to pick the best of several assets. */
export function scoreAsset(name: string, platform = process.platform, archStr = process.arch): number {
  const n = name.toLowerCase()
  const isArchive = n.endsWith('.tar.gz') || n.endsWith('.tgz') || n.endsWith('.zip')
  if (!isArchive) return -1 // skip .dmg / .sha256 / source tarballs

  const osOk =
    platform === 'darwin'
      ? n.includes('macos') || n.includes('darwin') || n.includes('osx')
      : platform === 'win32'
        ? n.includes('win') || n.includes('windows')
        : n.includes('linux') || n.includes('ubuntu')
  if (!osOk) return -1

  // arm64 vs x64: if the name names an arch, it must be ours; unnamed = acceptable.
  const wantArm = archStr === 'arm64'
  const namesArm = n.includes('arm64') || n.includes('aarch64')
  const namesX64 = n.includes('x64') || n.includes('x86_64') || n.includes('amd64')
  if (wantArm && namesX64) return -1
  if (!wantArm && namesArm) return -1

  let score = 1
  if ((wantArm && namesArm) || (!wantArm && namesX64)) score += 2 // exact arch named
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) score += 1 // prefer tarball over zip
  return score
}

/** Pick the best-matching asset for this OS/arch, or null if the release has none. */
export function pickReleaseAsset(
  assets: ReleaseAsset[],
  platform = process.platform,
  archStr = process.arch,
): ReleaseAsset | null {
  let best: ReleaseAsset | null = null
  let bestScore = 0
  for (const a of assets) {
    const s = scoreAsset(a.name, platform, archStr)
    if (s > bestScore) {
      best = a
      bestScore = s
    }
  }
  return best
}

/** Resolve the latest release of `repo` and provision its platform-matching
 *  `llama-server` into `<enginesRoot>/<destName>/`. Returns the server binary path.
 *  Throws `no_release_asset` (Error.message) when the latest release has no asset
 *  for this OS/arch — the catalog's OS prefilter should prevent reaching here, but
 *  this is the honest failure if a platform's build is missing. */
export async function provisionForkRelease(
  enginesRoot: string,
  repo: string,
  destName: string,
  onProgress?: (p: ProvisionProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  const destDir = join(enginesRoot, destName)
  if (existsSync(destDir)) {
    const found = findServer(destDir)
    if (found) return found
  }

  // Resolve the latest release + its assets via the GitHub API.
  const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`
  const res = await fetch(apiUrl, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'turbollm' },
    signal,
  })
  if (!res.ok) throw new Error(`could not query ${repo} releases: HTTP ${res.status}`)
  const rel = (await res.json()) as { tag_name?: string; assets?: ReleaseAsset[] }
  const asset = pickReleaseAsset(rel.assets ?? [])
  if (!asset) throw new Error('no_release_asset')

  mkdirSync(destDir, { recursive: true })
  const tmp = join(enginesRoot, asset.name)
  try {
    onProgress?.({ phase: 'downloading', pct: 0 })
    await downloadFile(asset.browser_download_url, tmp, onProgress, signal)
    onProgress?.({ phase: 'extracting', pct: -1 })
    await extractArchive(tmp, destDir)
    rmSync(tmp, { force: true })
  } catch (e) {
    rmSync(tmp, { force: true })
    rmSync(destDir, { recursive: true, force: true })
    throw e
  }

  const bin = findServer(destDir)
  if (!bin) throw new Error('llama-server not found in extracted release archive')
  return bin
}
