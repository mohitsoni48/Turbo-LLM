// Engine catalog (ADR-044). A hardcoded, browsable list of engines the user can
// one-click install from the Engines screen — generalizing the llama.cpp backend
// picker (download.ts) into a list that also covers Python engines (vLLM, MLX).
//
// The list itself ships in app code and updates only with app releases (no live
// catalog server — offline-first, ADR-009). Concrete versions resolve at INSTALL
// time: GitHub Releases for binary engines, the latest pip release for Python ones.
//
// Provisioning is one of:
//   - 'github-release': download a prebuilt binary asset (llama.cpp official).
//   - 'pip':            uv-bootstrapped venv + `uv pip install <pkg>` (vLLM, MLX).
//   - 'builtin':        already provisioned by another path (the auto default).
//
// Honesty rule (project HARD RULE / ADR-012 ethos): an engine is only listed as
// installable when a real provisioning path exists. TurboQuant is listed but
// `comingSoon` because the fork is currently built from source and publishes no
// prebuilt GitHub release — it flips to installable the day it does, by setting a
// `repo` + clearing the flag, no code change to the install machinery.

export type ProvisionType = 'github-release' | 'pip' | 'builtin'

export interface CatalogEngine {
  /** Stable catalog id (not the registry engine id). */
  id: string
  /** Display name. */
  name: string
  /** Registry engine `kind` once installed ('llama-server' | 'vllm' | 'mlx'). */
  kind: string
  /** One-line description for the catalog card. */
  description: string
  /** How this engine is provisioned. */
  provision: ProvisionType
  /** Project homepage / docs. */
  homepage: string
  /** `owner/repo` for github-release provisioning (resolved at install time). */
  repo?: string
  /** Platforms the engine can RUN on (process.platform values). */
  platforms: NodeJS.Platform[]
  /** Maturity on the supported platforms. */
  support: 'stable' | 'experimental'
  /** API path to POST to in order to install (empty for backend-picker engines). */
  installEndpoint: string
  /** Listed for awareness but not yet installable (no real provisioning path). */
  comingSoon?: boolean
  /** Extra context shown under the card (support caveats, etc.). */
  note?: string
}

const ALL: CatalogEngine[] = [
  {
    id: 'llama.cpp',
    name: 'llama.cpp',
    kind: 'llama-server',
    description:
      'The default GGUF engine. Pick the GPU backend that matches your hardware (CUDA, ROCm, Vulkan, Metal, CPU).',
    provision: 'github-release',
    homepage: 'https://github.com/ggml-org/llama.cpp',
    repo: 'ggml-org/llama.cpp',
    platforms: ['win32', 'darwin', 'linux'],
    support: 'stable',
    // llama.cpp expands into the backend sub-picker (existing UI); it has no single
    // install endpoint of its own.
    installEndpoint: '',
  },
  {
    id: 'vllm',
    name: 'vLLM',
    kind: 'vllm',
    description:
      'High-throughput production server for safetensors / HF models, with an OpenAI-compatible API. Best for NVIDIA GPUs.',
    provision: 'pip',
    homepage: 'https://github.com/vllm-project/vllm',
    repo: 'vllm-project/vllm',
    // Listed on every platform but only stable on Linux + NVIDIA. We never hard-
    // block (ADR-044) — the install attempt fails loudly where unsupported.
    platforms: ['linux', 'darwin', 'win32'],
    support: 'experimental',
    installEndpoint: '/api/v1/engines/vllm',
    note: 'Officially supported on Linux + NVIDIA/CUDA. macOS is CPU-only experimental; Windows is unsupported upstream. Installs a multi-GB Python environment.',
  },
  {
    id: 'mlx',
    name: 'MLX',
    kind: 'mlx',
    description: "Apple's framework for fast inference on Apple Silicon, with an OpenAI-compatible server.",
    provision: 'pip',
    homepage: 'https://github.com/ml-explore/mlx-lm',
    repo: 'ml-explore/mlx-lm',
    platforms: ['darwin'],
    support: 'stable',
    installEndpoint: '/api/v1/engines/mlx',
    note: 'macOS (Apple Silicon) only.',
  },
  {
    id: 'turboquant',
    name: 'TurboQuant',
    kind: 'llama-server',
    description:
      'llama.cpp fork with TurboQuant KV-cache compression (turbo2/3/4) and NextN self-speculative decoding for higher throughput and longer context.',
    provision: 'github-release',
    homepage: 'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant',
    repo: 'AtomicBot-ai/atomic-llama-cpp-turboquant',
    // The fork currently publishes prebuilt binaries for macOS (Apple Silicon)
    // only. The OS prefilter hides it elsewhere; it appears + installs on macOS.
    // Add 'win32'/'linux' here the moment the fork ships those release assets.
    platforms: ['darwin'],
    support: 'experimental',
    installEndpoint: '/api/v1/engines/turboquant',
    note: 'Prebuilt binaries are published for macOS (Apple Silicon). Windows/Linux builds are not yet released by the fork.',
  },
]

/** The catalog as seen on this platform: engines runnable here, plus a per-entry
 *  `supportedHere` flag so the UI can dim ones that won't run on this OS. */
export function catalogForPlatform(platform: NodeJS.Platform = process.platform): Array<CatalogEngine & { supportedHere: boolean }> {
  return ALL.map((e) => ({ ...e, supportedHere: e.platforms.includes(platform) }))
}

/** Look up a single catalog entry by id. */
export function catalogEngine(id: string): CatalogEngine | undefined {
  return ALL.find((e) => e.id === id)
}
