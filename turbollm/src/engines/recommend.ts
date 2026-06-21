// Engine recommendation (engine overhaul, Phase 1). Given the detected hardware
// (hardware.ts) and the catalog (catalog.ts), work out — per engine — which
// variants this box can run, and pick the single headline engine/variant to
// lead with. Pure: callers pass the HardwareProfile + the engine list, so this
// is testable with fake hardware over a fake catalog.
import { type CatalogEngine, type EngineVariant, llamaCppVariants } from './catalog'
import type { HardwareProfile } from './hardware'
import { evaluateVariant } from './compat'

export interface EngineFit {
  engine: CatalogEngine
  variants: EngineVariant[] // the engine's full variant list
  compatible: EngineVariant[] // those passing evaluateVariant
  incompatibleReason?: string // set when compatible.length === 0 (closest variant's reason)
  recommended: boolean // true for the single headline engine
}

export interface EngineRecommendation {
  recommended: { engineId: string; variantId: string } | null
  fits: EngineFit[]
}

// Higher = faster, used to rank candidate variants for the headline pick.
const SPEED_RANK: Record<NonNullable<EngineVariant['speed']>, number> = {
  fastest: 3,
  fast: 2,
  baseline: 1,
}
function speedScore(v: EngineVariant): number {
  return v.speed ? SPEED_RANK[v.speed] : 0
}

/** Resolve an engine's variants: llama.cpp derives them from the backend list;
 *  everything else uses its inline list (or none). */
function variantsFor(engine: CatalogEngine): EngineVariant[] {
  return engine.id === 'llama.cpp' ? llamaCppVariants() : (engine.variants ?? [])
}

export function recommendEngines(p: HardwareProfile, engines: CatalogEngine[]): EngineRecommendation {
  const fits: EngineFit[] = engines.map((engine) => {
    const variants = variantsFor(engine)
    const compatible = variants.filter((v) => evaluateVariant(p, v.requires).ok)
    let incompatibleReason: string | undefined
    if (compatible.length === 0 && variants.length > 0) {
      // "Closest" = the first variant carrying a real reason (else the first).
      const withReason = variants
        .map((v) => evaluateVariant(p, v.requires).reason)
        .find((r): r is string => r !== undefined)
      incompatibleReason = withReason ?? evaluateVariant(p, variants[0].requires).reason
    }
    return { engine, variants, compatible, incompatibleReason, recommended: false }
  })

  // Headline = the best STABLE compatible variant across all engines, ranked by
  // speed, with a safe-default bias toward llama.cpp on ties.
  let bestFit: EngineFit | null = null
  let bestVariant: EngineVariant | null = null
  let bestScore = -1
  for (const fit of fits) {
    for (const v of fit.compatible) {
      if (v.stability !== 'stable') continue
      const score = speedScore(v)
      const isLlama = fit.engine.id === 'llama.cpp'
      const bestIsLlama = bestFit?.engine.id === 'llama.cpp'
      const better = score > bestScore || (score === bestScore && isLlama && !bestIsLlama)
      if (better) {
        bestScore = score
        bestFit = fit
        bestVariant = v
      }
    }
  }

  if (bestFit && bestVariant) {
    bestFit.recommended = true
    return { recommended: { engineId: bestFit.engine.id, variantId: bestVariant.id }, fits }
  }
  return { recommended: null, fits }
}
