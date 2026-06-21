// Card-derived recommended sampling (ADR-099, v1.2.0). Extracts the model author's
// recommended sampling settings (temperature / top_k / top_p / min_p) from a Hugging
// Face model card so auto-tune can prefill the profile's Sampling block.
//
// HYBRID extraction (ADR-099): a deterministic heuristic parser runs FIRST (this module's
// `parseCardSampling`); only when it finds nothing does the bench runner fall back to
// asking the just-tuned local model to read the card and emit JSON (`parseLlmSampling`
// validates that reply). Both paths funnel through the same clamp so nothing out-of-range
// or unparseable ever lands in a profile. PURE + unit-tested — the bench runner owns the
// network/engine I/O around it.

/** The four sampling knobs a model card commonly recommends. Field names match the
 *  `Sampling` interface in profile.ts exactly, so a result spreads straight onto a
 *  profile's `sampling` block with no remapping. All optional — only stated values land. */
export interface CardSampling {
  temp?: number
  topP?: number
  topK?: number
  minP?: number
}

interface FieldSpec {
  key: keyof CardSampling
  /** Regex fragment matching the card's name(s) for this knob. */
  alias: string
  min: number
  max: number
  integer?: boolean
}

/** Per-knob aliases + valid ranges. Ranges double as the sanity gate (a value outside
 *  them is dropped, never clamped-to-edge — an out-of-range number signals a mis-parse,
 *  not a real recommendation). top_k is an integer count; the rest are floats. */
const FIELDS: FieldSpec[] = [
  { key: 'temp', alias: 'temp(?:erature)?', min: 0, max: 2 },
  { key: 'topP', alias: 'top[_\\-\\s]?p', min: 0, max: 1 },
  { key: 'topK', alias: 'top[_\\-\\s]?k', min: 0, max: 1000, integer: true },
  { key: 'minP', alias: 'min[_\\-\\s]?p', min: 0, max: 1 },
]

// A number: integer or decimal, allowing a leading-dot form (".95"). No sign — all four
// knobs are non-negative, and a stray "-" simply won't match (safer than negative noise).
const NUM = '(\\d*\\.?\\d+)'
// Separators allowed between a knob name and its value: whitespace, markdown table pipes,
// bold/italic asterisks, colons/equals, quotes/backticks/tildes. Capped tight (≤6) so a
// match can't reach across into an unrelated number further down the line.
const SEP = '[\\s:=|*"\'`~]{0,6}'

/** Sanity-filter a {@link CardSampling}: drop any field that's missing, non-finite, or
 *  outside its valid range; round integer fields. The single gate both extraction paths
 *  pass through. */
export function clampCardSampling(s: CardSampling): CardSampling {
  const out: CardSampling = {}
  for (const f of FIELDS) {
    const v = s[f.key]
    if (v == null || !Number.isFinite(v)) continue
    const n = f.integer ? Math.round(v) : v
    if (n < f.min || n > f.max) continue
    out[f.key] = n
  }
  return out
}

/** Heuristic (deterministic) parse of a model card's recommended sampling. Scans for the
 *  FIRST `name <sep> number` occurrence of each knob — model cards state recommended
 *  settings once, usually in a table or a "recommended settings" line near the top
 *  (e.g. `temperature: 0.6`, `top_p = 0.95`, `| Top-K | 20 |`, `**min_p:** 0`). Misses
 *  prose-only phrasings ("use a low temperature") on purpose — that's the LLM fallback's
 *  job. Result is already clamped; an empty object means "found nothing parseable". */
export function parseCardSampling(card: string): CardSampling {
  const out: CardSampling = {}
  if (!card) return out
  // Strip fenced code blocks first: usage snippets (`temperature=0`, eval configs, etc.)
  // carry demo values, NOT the author's recommendation — scanning them produces false
  // positives (verified live: Mistral-7B's card has `temperature=0` in an example). Real
  // recommendations live in prose/tables, which survive. Prose-only cards still fall through
  // to the LLM fallback on the original (uncapped) card text.
  const prose = card.replace(/```[\s\S]*?```/g, ' ').replace(/~~~[\s\S]*?~~~/g, ' ')
  for (const f of FIELDS) {
    const re = new RegExp(`\\b${f.alias}\\b${SEP}${NUM}`, 'i')
    const m = re.exec(prose)
    if (!m) continue
    const v = Number(m[1])
    if (Number.isFinite(v)) out[f.key] = v
  }
  return clampCardSampling(out)
}

/** True when at least one knob was extracted. (0 is a valid value — e.g. `min_p: 0` —
 *  so this checks presence, not truthiness.) */
export function hasAnySampling(s: CardSampling): boolean {
  return s.temp != null || s.topP != null || s.topK != null || s.minP != null
}

/** Build the LLM-fallback prompt: ask the model to read its own card and emit ONLY a JSON
 *  object of recommended sampling values (null for anything not stated). The card is
 *  capped so a small-context model can still take it alongside the instruction. */
export function buildCardExtractionPrompt(card: string): string {
  const trimmed = card.slice(0, 8000)
  return [
    "Extract the model author's RECOMMENDED sampling settings from the model card below.",
    'Output ONLY a single JSON object, no prose, with exactly these keys:',
    '{"temperature": number|null, "top_k": number|null, "top_p": number|null, "min_p": number|null}',
    'Use a value ONLY if the card explicitly recommends it; otherwise use null. Do not guess.',
    '',
    'MODEL CARD:',
    trimmed,
  ].join('\n')
}

/** Parse the LLM fallback's reply: pull the first JSON object out of the text (tolerating
 *  ```json fences / surrounding prose), read the four keys (number or numeric string),
 *  and clamp. Returns {} on anything unparseable — never throws. */
export function parseLlmSampling(text: string): CardSampling {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return {}
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(m[0]) as Record<string, unknown>
  } catch {
    return {}
  }
  if (typeof obj !== 'object' || obj === null) return {}
  const num = (v: unknown): number | null => {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
    return null
  }
  const out: CardSampling = {}
  const map: [string, keyof CardSampling][] = [
    ['temperature', 'temp'],
    ['top_p', 'topP'],
    ['top_k', 'topK'],
    ['min_p', 'minP'],
  ]
  for (const [jsonKey, field] of map) {
    const v = num(obj[jsonKey])
    if (v !== null) out[field] = v
  }
  return clampCardSampling(out)
}
