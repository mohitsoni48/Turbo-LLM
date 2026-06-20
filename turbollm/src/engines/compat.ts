// Engine ↔ model compatibility (ADR-044). The single source of truth for which
// model formats an engine kind can load. Used by the load guard (routes), the
// model-list overlay (filter by active engine), and the CLI auto-load. The web UI
// mirrors this rule in web/src/lib/engineCompat.ts — keep the two in sync.

import type { HardwareProfile } from './hardware'
import type { HardwareReq } from './catalog'
import type { GpuVendor } from '../sysinfo/sysinfo'

export type ModelFormat = 'gguf' | 'mlx'

/**
 * True when an engine of `engineKind` can load a model of `format`:
 *   - llama.cpp and its forks (e.g. TurboQuant, kind 'llama-server') → GGUF
 *   - MLX (kind 'mlx') → MLX-format safetensors directories
 *   - vLLM (kind 'vllm') → HF safetensors directories — the same on-disk shape the
 *     scanner tags 'mlx' (config.json + *.safetensors + tokenizer)
 */
export function engineAcceptsFormat(engineKind: string, format: ModelFormat): boolean {
  if (engineKind === 'mlx') return format === 'mlx'
  if (engineKind === 'vllm') return format === 'mlx'
  return format === 'gguf'
}

/**
 * The value an OpenAI-compatible request must put in its `model` field for this engine.
 *
 * llama.cpp ignores the field (it serves the single loaded model), so we leave the
 * caller's value alone. mlx-lm and vLLM, however, treat `model` as the model to serve
 * and 404 (vLLM) or fail to load (mlx-lm) if it doesn't match a known name — they would
 * never match TurboLLM's internal model key (a display name with spaces). We launch both
 * under the fixed alias `default_model` (mlx-lm's built-in alias for its `--model`; vLLM
 * via `--served-model-name`), so requests must send exactly that. Returns null when the
 * engine ignores the field and the original value should be kept.
 */
export const ENGINE_MODEL_ALIAS = 'default_model'
export function engineModelAlias(engineKind: string): string | null {
  return engineKind === 'mlx' || engineKind === 'vllm' ? ENGINE_MODEL_ALIAS : null
}

// ─── Hardware ↔ variant matching (engine overhaul, Phase 1) ──────────────────
// PURE matcher: given a HardwareProfile and a variant's HardwareReq, decide
// whether this box can run the variant, with a human-readable reason when not.
// No I/O, no detection (detection lives in hardware.ts) — so it's trivially
// testable and the same code drives both the recommender and the UI.

const VENDOR_DISPLAY: Record<GpuVendor, string> = {
  nvidia: 'NVIDIA',
  amd: 'AMD',
  intel: 'Intel',
  apple: 'Apple Silicon',
  unknown: 'no detected GPU',
}

const PLATFORM_DISPLAY: Record<string, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
}

function platformName(p: NodeJS.Platform): string {
  return PLATFORM_DISPLAY[p] ?? p
}

/** Humanize an allowed-platform set, e.g. ['darwin'] → 'macOS only',
 *  ['win32','linux'] → 'Windows & Linux only'. */
function platformReason(allowed: NodeJS.Platform[]): string {
  const names = allowed.map(platformName)
  const joined = names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`
  return `${joined} only`
}

/**
 * True when `p` satisfies every present constraint in `r`. A *missing* signal
 * never causes a false exclusion: if we couldn't detect VRAM (p.vramMb === 0)
 * we skip the VRAM gate rather than reject. `minCudaCC` is accepted but NOT
 * enforced in v1 (we can't reliably detect compute capability yet).
 */
export function evaluateVariant(p: HardwareProfile, r: HardwareReq): { ok: boolean; reason?: string } {
  if (r.platform && !r.platform.includes(p.platform)) {
    return { ok: false, reason: platformReason(r.platform) }
  }
  if (r.arch && !r.arch.includes(p.arch)) {
    return { ok: false, reason: `Needs ${r.arch.join(' / ')}` }
  }
  if (r.gpuVendor && !r.gpuVendor.includes(p.gpuVendor)) {
    const needs = r.gpuVendor.map((v) => VENDOR_DISPLAY[v]).join(' / ')
    const article = /^[NAEIO]/.test(needs) ? 'an' : 'a'
    return { ok: false, reason: `Needs ${article} ${needs} GPU — you have ${VENDOR_DISPLAY[p.gpuVendor]}` }
  }
  // Only gate on VRAM when we actually have a reading (p.vramMb > 0).
  if (r.minVramMb !== undefined && p.vramMb > 0 && p.vramMb < r.minVramMb) {
    const gb = Math.round(r.minVramMb / 1024)
    return { ok: false, reason: `Needs ~${gb} GB VRAM` }
  }
  // minCudaCC: intentionally ignored in v1 (tiered gating, see HardwareReq).
  return { ok: true }
}
