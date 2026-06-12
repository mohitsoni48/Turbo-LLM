// LoadProfile: per-model launch parameters, default derivation, VRAM-fit
// estimation, and the profile->llama-server arg mapping (spec 05). This
// productizes the hand-tuned models.json knowledge.
import type { Capabilities } from '../config/config'
import type { SysInfo } from '../sysinfo/sysinfo'
import type { ModelEntry } from './scanner'

export interface Sampling {
  temp: number
  topP: number
  topK: number
  minP: number
  repeatPenalty: number
  presencePenalty: number
}

export interface LoadProfile {
  ctx: number
  ngl: number
  nCpuMoe: number
  parallel: number
  kvUnified: boolean
  kvTypeK: string
  kvTypeV: string
  flashAttn: 'auto' | 'on' | 'off'
  threads: number
  threadsBatch: number
  useMmproj: boolean
  mmprojGpu: boolean
  imageMaxTokens: number
  cacheReuse: number
  useJinja: boolean
  chatTemplateFile: string
  speculative: 'off' | 'nextn' | 'draft'
  draftModelPath: string
  sampling: Sampling
  extraArgs: string[]
  tunedBy?: string
}

export type FitVerdict = 'fits' | 'tight' | 'overflow' | 'cpu' | 'unknown'

export interface VramFit {
  estMb: number
  totalVramMb: number
  pct: number
  verdict: FitVerdict
}

const HEAD_DIM = 128 // embedLen/headCount approximation (spec 05 §6)

function kvBytesPerElem(t: string): number {
  switch (t) {
    case 'f16': return 2
    case 'q8_0': case 'q8_1': return 1
    case 'q5_0': case 'q5_1': return 0.625
    case 'q4_0': case 'q4_1': case 'turbo4': return 0.5
    case 'turbo3': return 0.375
    case 'turbo2': return 0.25
    default: return 2
  }
}

export function defaultSampling(): Sampling {
  return { temp: 0.8, topP: 0.95, topK: 40, minP: 0.05, repeatPenalty: 1.0, presencePenalty: 0.0 }
}

/** Estimate GPU memory use for a profile (spec 05 §6). Deterministic math — the
 *  only "numbers" we show pre-run; always labeled an estimate (ADR-012). */
export function estimateVram(p: LoadProfile, m: ModelEntry, sys: SysInfo): VramFit {
  const totalVramMb = sys.gpus[0]?.vramMb ?? 0
  if (totalVramMb === 0) return { estMb: 0, totalVramMb: 0, pct: 0, verdict: 'cpu' }

  const sizeMb = m.sizeBytes / 1e6
  const blocks = m.blockCount || 1
  const gpuFrac = m.moe
    ? 1 - 0.85 * (p.nCpuMoe / blocks)
    : Math.min(p.ngl, blocks) / blocks
  const weightsMb = sizeMb * Math.max(0, Math.min(1, gpuFrac))

  const kvHeads = m.headCountKv || 8
  const kvElems = 2 * blocks * p.ctx * kvHeads * HEAD_DIM
  const kvMb = ((kvElems * kvBytesPerElem(p.kvTypeK)) / 1e6) * (p.kvUnified ? 1 : Math.max(1, p.parallel))

  const mmprojMb = p.useMmproj && p.mmprojGpu && m.mmprojPath ? 600 : 0
  const estMb = Math.round(weightsMb + kvMb + 800 + mmprojMb)
  const pct = estMb / totalVramMb
  const verdict: FitVerdict = pct <= 0.8 ? 'fits' : pct <= 0.95 ? 'tight' : 'overflow'
  return { estMb, totalVramMb, pct, verdict }
}

/** Computed defaults for a model (spec 05 §3). NOT saved until the user saves. */
export function deriveDefault(m: ModelEntry, sys: SysInfo): LoadProfile {
  const hasGpu = sys.gpus.length > 0
  const base: LoadProfile = {
    ctx: Math.min(m.nativeCtx || 8192, 8192),
    ngl: hasGpu ? 99 : 0,
    nCpuMoe: 0,
    parallel: 1,
    kvUnified: true,
    kvTypeK: 'f16',
    kvTypeV: 'f16',
    flashAttn: 'auto',
    threads: 0,
    threadsBatch: 0,
    useMmproj: m.vision,
    mmprojGpu: true,
    imageMaxTokens: 0,
    cacheReuse: 256,
    useJinja: m.hasChatTemplate,
    chatTemplateFile: '',
    speculative: 'off',
    draftModelPath: '',
    sampling: defaultSampling(),
    extraArgs: [],
  }

  // MoE: pick the smallest CPU-offload that fits ~85% of VRAM (spec 05 §3).
  if (m.moe && hasGpu && m.blockCount > 0) {
    const budget = (sys.gpus[0].vramMb || 0) * 0.85
    base.nCpuMoe = m.blockCount
    for (let n = 0; n <= m.blockCount; n += 2) {
      if (estimateVram({ ...base, nCpuMoe: n }, m, sys).estMb <= budget) {
        base.nCpuMoe = n
        break
      }
    }
  }
  return base
}

/** Merge defaults <- saved <- overrides (field-level; sampling deep-merged). */
export function resolveProfile(
  m: ModelEntry,
  sys: SysInfo,
  saved?: Partial<LoadProfile>,
  overrides?: Partial<LoadProfile>,
): LoadProfile {
  const base = deriveDefault(m, sys)
  return {
    ...base,
    ...(saved ?? {}),
    ...(overrides ?? {}),
    sampling: { ...base.sampling, ...(saved?.sampling ?? {}), ...(overrides?.sampling ?? {}) },
  }
}

/** Map a profile to llama-server args (spec 05 §8). The manager injects
 *  -m/--host/--port/--metrics/--no-webui; this returns everything else.
 *  Flags absent from the engine's capabilities are skipped (graceful degrade). */
export function profileToArgs(p: LoadProfile, m: ModelEntry, caps: Capabilities): string[] {
  const has = (flag: string) => caps.flags.length === 0 || caps.flags.includes(flag)
  const a: string[] = ['-c', String(p.ctx)]
  if (p.ngl > 0) a.push('-ngl', String(p.ngl))
  // Always pin --parallel: omitting it makes llama-server auto-pick 4 slots,
  // quadrupling KV memory (seen in logs).
  if (has('--parallel')) a.push('--parallel', String(p.parallel))
  if (p.parallel > 1 && p.kvUnified && has('--kv-unified')) a.push('--kv-unified')
  if (m.moe && p.nCpuMoe > 0 && has('--n-cpu-moe')) a.push('--n-cpu-moe', String(p.nCpuMoe))
  if (p.kvTypeK !== 'f16' && has('--cache-type-k')) a.push('--cache-type-k', p.kvTypeK)
  if (p.kvTypeV !== 'f16' && has('--cache-type-v')) a.push('--cache-type-v', p.kvTypeV)
  if (p.flashAttn !== 'auto' && has('--flash-attn')) a.push('--flash-attn', p.flashAttn)
  if (p.threads > 0) a.push('--threads', String(p.threads))
  if (p.threadsBatch > 0) a.push('--threads-batch', String(p.threadsBatch))
  if (m.vision && p.useMmproj && m.mmprojPath) a.push('--mmproj', m.mmprojPath)
  if (m.vision && p.useMmproj && !p.mmprojGpu && has('--no-mmproj-offload')) a.push('--no-mmproj-offload')
  if (p.imageMaxTokens > 0 && has('--image-max-tokens')) a.push('--image-max-tokens', String(p.imageMaxTokens))
  if (p.cacheReuse > 0 && has('--cache-reuse')) a.push('--cache-reuse', String(p.cacheReuse))
  if (p.useJinja && has('--jinja')) a.push('--jinja')
  if (p.chatTemplateFile && has('--chat-template-file')) a.push('--chat-template-file', p.chatTemplateFile)
  if (p.speculative === 'draft' && p.draftModelPath && has('--model-draft')) {
    a.push('--model-draft', p.draftModelPath, '--draft-max', '16', '--draft-min', '1')
  }
  // SPEC-GAP: NextN/MTP enable flag for the TurboQuant fork unverified; 'nextn'
  // is a no-op until confirmed against --help. (speculative === 'nextn')
  a.push(...p.extraArgs)
  return a
}
