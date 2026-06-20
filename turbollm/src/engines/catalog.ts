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

import { type BackendId, availableBackends } from './download'
import type { Arch } from './hardware'
import type { GpuVendor } from '../sysinfo/sysinfo'

export type ProvisionType = 'github-release' | 'pip' | 'builtin'

// ─── Variant model (engine overhaul, Phase 1) ───────────────────────────────
// A catalog engine can ship several installable *variants* — one per hardware
// path (e.g. llama.cpp has cuda/rocm/sycl/vulkan/metal/cpu). Each variant
// declares the hardware it needs (HardwareReq); the matcher (compat.evaluate-
// Variant) decides whether the current box can run it. This is additive: every
// existing CatalogEngine field/export is unchanged and `variants` is optional.

export interface HardwareReq {
  platform?: NodeJS.Platform[]
  arch?: Arch[]
  gpuVendor?: GpuVendor[] // any-of
  backend?: BackendId
  minVramMb?: number
  /** Accepted but NOT enforced in v1 (tiered gating — we can't reliably detect
   *  compute capability yet). Kept on the type so future tiers can use it. */
  minCudaCC?: number
}

export interface EngineVariant {
  id: string
  label: string
  repo: string // OG repo (credit + source link)
  requires: HardwareReq
  stability: 'stable' | 'experimental'
  speed?: 'baseline' | 'fast' | 'fastest'
  backendId?: BackendId // set for official llama.cpp variants
  hasPrebuilt: boolean // false => "build it, then Add your own"
}

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
  /** Installable variants (one per hardware path). Optional: llama.cpp derives
   *  its variants at call time via llamaCppVariants(); other engines list them
   *  inline or leave undefined (handled in later phases). */
  variants?: EngineVariant[]
}

// Maps each llama.cpp BackendId to the hardware it needs + how fast it is.
// We DERIVE the variant list from availableBackends() rather than hand-listing
// the 6 backends, so the catalog never drifts from download.ts.
const LLAMA_BACKEND_REQ: Record<BackendId, { requires: HardwareReq; speed: EngineVariant['speed'] }> = {
  cuda: { requires: { gpuVendor: ['nvidia'], backend: 'cuda' }, speed: 'fast' },
  rocm: { requires: { gpuVendor: ['amd'], backend: 'rocm' }, speed: 'fast' },
  sycl: { requires: { gpuVendor: ['intel'], backend: 'sycl' }, speed: 'baseline' },
  vulkan: { requires: { backend: 'vulkan' }, speed: 'baseline' }, // any GPU
  metal: { requires: { platform: ['darwin'], gpuVendor: ['apple'], backend: 'metal' }, speed: 'fast' },
  cpu: { requires: { backend: 'cpu' }, speed: 'baseline' }, // always ok
}

/** llama.cpp's variants for this OS/arch, derived from the official backend
 *  list (download.ts) so the two never diverge. */
export function llamaCppVariants(): EngineVariant[] {
  return availableBackends().map((b) => {
    const { requires, speed } = LLAMA_BACKEND_REQ[b.id]
    return {
      id: `llama.cpp-${b.id}`,
      label: b.label,
      repo: 'ggml-org/llama.cpp',
      requires,
      stability: 'stable',
      speed,
      backendId: b.id,
      hasPrebuilt: true,
    }
  })
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
    // Classification-only variant (its pip install path is unchanged). Lets the
    // matcher/recommender reason about vLLM's fit on this box: Linux + NVIDIA.
    variants: [
      {
        id: 'vllm-cuda',
        label: 'CUDA (NVIDIA)',
        repo: 'vllm-project/vllm',
        requires: { platform: ['linux'], gpuVendor: ['nvidia'] },
        stability: 'experimental',
        speed: 'fastest',
        hasPrebuilt: true,
      },
    ],
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
    // Classification-only variant (its pip install path is unchanged). Lets the
    // matcher/recommender reason about MLX's fit on this box: macOS + Apple GPU.
    variants: [
      {
        id: 'mlx',
        label: 'Apple Metal',
        repo: 'ml-explore/mlx-lm',
        requires: { platform: ['darwin'], gpuVendor: ['apple'] },
        stability: 'stable',
        speed: 'fast',
        hasPrebuilt: true,
      },
    ],
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
    // Reflects the fork's current macOS-only prebuilt reality (later phases add
    // Windows/Linux variants when the fork ships those release assets).
    variants: [
      {
        id: 'turboquant-metal',
        label: 'Metal (Apple)',
        repo: 'AtomicBot-ai/atomic-llama-cpp-turboquant',
        requires: { platform: ['darwin'], gpuVendor: ['apple'] },
        stability: 'experimental',
        speed: 'fast',
        hasPrebuilt: true,
      },
    ],
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
