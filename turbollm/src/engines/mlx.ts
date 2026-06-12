// MLX engine provisioning (ADR-025, Phase 3). MLX is Apple's framework — a
// *second engine kind* on macOS, distinct from llama.cpp. It is not a single
// binary: we bootstrap `uv` (a self-contained Python package manager) into the
// app-data dir, create an isolated venv, install `mlx-lm`, and run its
// OpenAI-compatible server (`mlx_lm.server`). No system Python is touched.
//
// Runtime is macOS-only (mlx-lm needs Apple Metal). The uv *bootstrap* is
// cross-platform and independently testable; `ensureMlxEnv` guards on darwin.
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { downloadFile, extractArchive, findFile, type ProvisionProgress } from './download'

const execFileP = promisify(execFile)

// Pinned uv release (astral-sh/uv). Bump deliberately.
export const UV_VERSION = '0.11.21'
const UV_REPO = 'astral-sh/uv'

const uvBinName = process.platform === 'win32' ? 'uv.exe' : 'uv'

function uvAsset(): string {
  const cpu = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (process.platform === 'darwin') return `uv-${cpu}-apple-darwin.tar.gz`
  if (process.platform === 'win32') return `uv-${cpu}-pc-windows-msvc.zip`
  return `uv-${cpu}-unknown-linux-gnu.tar.gz`
}

/**
 * Ensure the `uv` binary is downloaded + extracted under <root>/uv; return its
 * path. Cross-platform and independently verifiable (used as MLX's bootstrap).
 */
export async function ensureUv(root: string, onProgress?: (p: ProvisionProgress) => void): Promise<string> {
  const dir = join(root, 'uv')
  if (existsSync(dir)) {
    const found = findFile(dir, uvBinName)
    if (found) return found
  }
  mkdirSync(dir, { recursive: true })
  const asset = uvAsset()
  const tmp = join(root, asset)
  const url = `https://github.com/${UV_REPO}/releases/download/${UV_VERSION}/${asset}`
  onProgress?.({ phase: 'downloading', pct: 0 })
  await downloadFile(url, tmp, onProgress)
  onProgress?.({ phase: 'extracting', pct: -1 })
  await extractArchive(tmp, dir)
  rmSync(tmp, { force: true })
  const bin = findFile(dir, uvBinName)
  if (!bin) throw new Error('uv binary not found after extraction')
  return bin
}

export interface MlxRuntime {
  /** venv python interpreter path */
  python: string
  /** mlx-lm version string, from probe */
  version: string
}

function venvPython(envDir: string): string {
  return process.platform === 'win32'
    ? join(envDir, 'Scripts', 'python.exe')
    : join(envDir, 'bin', 'python')
}

/**
 * Provision an isolated MLX runtime: uv → venv → `uv pip install mlx-lm`.
 * macOS-only (mlx-lm requires Apple Metal). Returns the venv python + version.
 */
export async function ensureMlxEnv(root: string, onProgress?: (p: ProvisionProgress) => void): Promise<MlxRuntime> {
  if (process.platform !== 'darwin') {
    throw new Error('MLX requires macOS (Apple Silicon).')
  }
  const uv = await ensureUv(root, onProgress)
  const envDir = join(root, 'mlx', 'venv')
  const py = venvPython(envDir)

  if (!existsSync(py)) {
    onProgress?.({ phase: 'extracting', pct: -1 })
    await execFileP(uv, ['venv', envDir], { cwd: root })
  }
  // Install (or no-op if already satisfied) mlx-lm into the venv.
  onProgress?.({ phase: 'extracting', pct: -1 })
  await execFileP(uv, ['pip', 'install', '--python', py, 'mlx-lm'], {
    cwd: root,
    maxBuffer: 16 * 1024 * 1024,
  })

  const version = await probeMlx(py)
  return { python: py, version }
}

/** Read the installed mlx-lm version (also serves as a smoke test that it imports). */
export async function probeMlx(python: string): Promise<string> {
  const { stdout } = await execFileP(
    python,
    ['-c', 'import mlx_lm, importlib.metadata as m; print(m.version("mlx-lm"))'],
    { timeout: 20_000 },
  )
  return `mlx-lm ${stdout.trim()}`
}

/**
 * Command + args to launch the MLX OpenAI-compatible server for a model.
 * `model` is an MLX model dir or an HF repo id (mlx-lm can fetch the latter).
 */
export function mlxServerCommand(python: string, model: string, port: number, host: string): { cmd: string; args: string[] } {
  return {
    cmd: python,
    args: ['-m', 'mlx_lm', 'server', '--model', model, '--host', host, '--port', String(port)],
  }
}
