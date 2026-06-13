// Featured GGUF repos for the Discover rail (spec 10 §7). MVP source is a static,
// embedded list — no network. The daemon ships its own `internal/hf/featured.json`;
// this is the client-side mirror so the rail renders instantly and fully offline.
//
// Each entry carries a per-VRAM-tier suggested quant so the rail can hint the right
// download for the user's GPU. Tiers are GB of VRAM: 8 / 12 / 16 / 24 / 32+.
//
// Repo ids verified against current HF slugs at implementation time; if a repo moves,
// update the `repo` field here and in the daemon's featured.json (SPEC-GAP otherwise).

export type VramTier = '8' | '12' | '16' | '24' | '32+'

export type FeaturedRepo = {
  repo: string
  name: string
  /** ≤ 90 chars (spec 10 §7). */
  blurb: string
  gated?: boolean
  /** Suggested quant per VRAM tier. */
  quants: Record<VramTier, string>
}

export const FEATURED_REPOS: FeaturedRepo[] = [
  {
    repo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
    name: 'Qwen3.6 35B-A3B',
    blurb: 'Sparse MoE flagship — 35B total, 3B active. Fast for its size.',
    quants: { '8': 'IQ2_XXS', '12': 'IQ3_XXS', '16': 'Q3_K_M', '24': 'Q4_K_M', '32+': 'Q5_K_M' },
  },
  {
    repo: 'unsloth/Qwen3.6-27B-GGUF',
    name: 'Qwen3.6 27B',
    blurb: 'Dense 27B — strong general reasoning, broad quant range.',
    quants: { '8': 'IQ2_XS', '12': 'IQ3_M', '16': 'Q3_K_L', '24': 'Q5_K_M', '32+': 'Q6_K' },
  },
  {
    repo: 'unsloth/Gemma-4-26B-A4B-GGUF',
    name: 'Gemma-4 26B-A4B',
    blurb: 'Google MoE with vision — 26B total, 4B active. Multimodal.',
    quants: { '8': 'IQ2_XXS', '12': 'IQ3_XXS', '16': 'Q3_K_M', '24': 'Q4_K_M', '32+': 'Q5_K_M' },
  },
  {
    repo: 'unsloth/Gemma-4-E4B-GGUF',
    name: 'Gemma-4 E4B',
    blurb: 'Compact 4B — runs anywhere, vision-capable, great laptop pick.',
    quants: { '8': 'Q4_K_M', '12': 'Q5_K_M', '16': 'Q6_K', '24': 'Q8_0', '32+': 'Q8_0' },
  },
  {
    repo: 'unsloth/Qwen3.5-9B-GGUF',
    name: 'Qwen3.5 9B',
    blurb: 'Dense 9B — efficient, fits midrange GPUs at good quant.',
    quants: { '8': 'Q3_K_M', '12': 'Q4_K_M', '16': 'Q5_K_M', '24': 'Q6_K', '32+': 'Q8_0' },
  },
  {
    repo: 'unsloth/GLM-5-Air-GGUF',
    name: 'GLM-5 Air',
    blurb: 'Zhipu MoE — efficient long-context generalist.',
    quants: { '8': 'IQ2_XS', '12': 'IQ3_M', '16': 'Q3_K_M', '24': 'Q4_K_M', '32+': 'Q5_K_M' },
  },
  {
    repo: 'unsloth/Llama-3.3-70B-Instruct-GGUF',
    name: 'Llama 3.3 70B',
    blurb: 'Meta 70B — gated; accept the license + add a token to download.',
    gated: true,
    quants: { '8': 'IQ1_M', '12': 'IQ2_XXS', '16': 'IQ2_M', '24': 'IQ3_M', '32+': 'Q4_K_M' },
  },
  {
    repo: 'unsloth/gpt-oss-20b-GGUF',
    name: 'GPT-OSS 20B',
    blurb: 'OpenAI open-weights 20B — strong tool-use and reasoning.',
    quants: { '8': 'IQ2_M', '12': 'Q3_K_M', '16': 'Q4_K_M', '24': 'Q5_K_M', '32+': 'Q6_K' },
  },
]

/** Pick the VRAM tier bucket for a given GPU VRAM (MB). Falls back to '16' (the dev
 *  box) when VRAM is unknown so the rail always shows a suggested quant. */
export function vramTier(vramMb: number | undefined): VramTier {
  if (!vramMb) return '16'
  const gb = vramMb / 1024
  if (gb < 10) return '8'
  if (gb < 14) return '12'
  if (gb < 20) return '16'
  if (gb < 28) return '24'
  return '32+'
}
