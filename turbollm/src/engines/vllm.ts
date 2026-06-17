// vLLM engine provisioning (ADR-044). vLLM is a Python production inference
// server with an OpenAI-compatible API — a *third engine kind* alongside
// llama.cpp and MLX. Like MLX it is not a single binary: we reuse the uv
// bootstrap (`ensureUv`, shared with mlx.ts), create an isolated venv, install
// `vllm`, and run its OpenAI server. No system Python is touched.
//
// Platform reality: vLLM officially targets Linux + NVIDIA/CUDA. macOS is CPU-
// only experimental; Windows is unsupported upstream. We do NOT hard-block any
// platform (ADR-044) — the catalog surfaces support level and the install simply
// attempts `uv pip install vllm`, which fails loudly on an unsupported platform.
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ensureUv } from './mlx'
import type { ProvisionProgress } from './download'

const execFileP = promisify(execFile)

// Python line vLLM supports. uv fetches a matching interpreter if absent, so the
// user needs no system Python. Bump deliberately as vLLM's support window moves.
const VLLM_PYTHON = '3.12'

export interface VllmRuntime {
  /** venv python interpreter path */
  python: string
  /** vllm version string, from probe */
  version: string
}

function venvPython(envDir: string): string {
  return process.platform === 'win32'
    ? join(envDir, 'Scripts', 'python.exe')
    : join(envDir, 'bin', 'python')
}

/**
 * Provision an isolated vLLM runtime: uv → venv (pinned python) → `uv pip
 * install vllm`. The install pulls torch + CUDA wheels and is multi-GB, so the
 * caller should surface indeterminate progress. Returns the venv python + version.
 */
export async function ensureVllmEnv(root: string, onProgress?: (p: ProvisionProgress) => void): Promise<VllmRuntime> {
  const uv = await ensureUv(root, onProgress)
  const envDir = join(root, 'vllm', 'venv')
  const py = venvPython(envDir)

  if (!existsSync(py)) {
    onProgress?.({ phase: 'extracting', pct: -1 })
    // --python <ver> tells uv to fetch + use that interpreter line if the venv
    // doesn't exist yet; uv downloads a standalone build when none is installed.
    await execFileP(uv, ['venv', '--python', VLLM_PYTHON, envDir], { cwd: root })
  }
  // Install (or no-op if already satisfied) vllm into the venv. Large download;
  // generous buffer + no timeout (pip resolves + compiles for minutes).
  onProgress?.({ phase: 'extracting', pct: -1 })
  await execFileP(uv, ['pip', 'install', '--python', py, 'vllm'], {
    cwd: root,
    maxBuffer: 64 * 1024 * 1024,
  })

  const version = await probeVllm(py)
  return { python: py, version }
}

/** Read the installed vllm version (also a smoke test that it imports). */
export async function probeVllm(python: string): Promise<string> {
  const { stdout } = await execFileP(
    python,
    ['-c', 'import importlib.metadata as m; print(m.version("vllm"))'],
    { timeout: 30_000 },
  )
  return `vllm ${stdout.trim()}`
}

/**
 * Command + args to launch the vLLM OpenAI-compatible server for a model.
 * `model` is an HF repo id (e.g. "meta-llama/Llama-3.1-8B-Instruct") or a local
 * model directory — vLLM resolves both. We invoke the stable module entrypoint
 * (`vllm.entrypoints.openai.api_server`) rather than the `vllm` console script so
 * the launch path doesn't depend on the venv bin being on PATH.
 *
 * `tensorParallelSize` (ADR-054) shards the model across N GPUs via vLLM's
 * `--tensor-parallel-size`. 1 (or undefined) is vLLM's single-GPU default and emits
 * no flag, so existing single-GPU launches are unchanged.
 */
export function vllmServerCommand(
  python: string,
  model: string,
  port: number,
  host: string,
  tensorParallelSize = 1,
): { cmd: string; args: string[] } {
  const args = [
    '-m', 'vllm.entrypoints.openai.api_server',
    '--model', model,
    // Serve under a fixed alias so requests can address the model by a stable name
    // (TurboLLM's internal key is a display string with spaces). Mirrors mlx-lm's
    // built-in `default_model` alias; see engineModelAlias() in compat.ts.
    '--served-model-name', 'default_model',
    '--host', host,
    '--port', String(port),
  ]
  if (tensorParallelSize > 1) args.push('--tensor-parallel-size', String(tensorParallelSize))
  return { cmd: python, args }
}
