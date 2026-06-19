// F-022: heuristic research referee (Tier 1 only).
// Checks each cited sentence in the model's reply against the retrieved source
// passages to detect unsupported claims. Pure string/regex — no IO, no LLM calls.
import type { ResearchSource, ClaimVerdict } from '../chat/db.js'

// ResearchSource + ClaimVerdict are owned by chat/db.ts (persisted with the message);
// re-exported here so callers can import them alongside checkReply.
export type { ResearchSource, ClaimVerdict }

// ── Stop words for key-term extraction ───────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'this', 'that', 'it', 'its', 'as', 'do', 'did', 'does', 'have', 'has',
  'had', 'not', 'no', 'so', 'if', 'up', 'out', 'can', 'will', 'just',
  'more', 'also', 'than', 'then', 'when', 'how', 'what', 'which', 'who',
  'see', 'all', 'here', 'there', 'they', 'them', 'their', 'my', 'your',
  'our', 'its', 'we', 'he', 'she', 'you', 'i',
])

/** Extract 3+ char non-stopword tokens from a string. */
function extractKeyTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
}

/** Fraction of keyTerms that appear in passage (0.0–1.0). */
function termOverlap(keyTerms: string[], passage: string): number {
  if (keyTerms.length === 0) return 0
  const lp = passage.toLowerCase()
  const hits = keyTerms.filter((t) => lp.includes(t)).length
  return hits / keyTerms.length
}

// ── Sentence tokenisation ─────────────────────────────────────────────────────

/**
 * Split text into sentences on `.?!` boundaries.
 * Returns non-empty trimmed sentence strings.
 */
function tokeniseSentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// ── Citation detection ────────────────────────────────────────────────────────

/** URL pattern — matches http(s):// URLs */
const URL_RE = /https?:\/\/[\w./-]+/gi
/** Domain-only mention pattern — e.g. "python.org" or "(wikipedia.org)" */
const DOMAIN_RE = /\b([\w-]+\.(com|org|net|edu|gov|io|co|uk|de|fr|jp|au|ca)[\w/.]*)/gi
/** Bracket citation [1], [2], etc. */
const BRACKET_RE = /\[(\d+)\]/g

interface CitationMatch {
  type: 'url' | 'domain' | 'bracket'
  value: string
  /** Index of referenced source for bracket citations */
  sourceIndex?: number
}

function detectCitation(sentence: string): CitationMatch | null {
  // Full URL first
  const urlMatch = sentence.match(URL_RE)
  if (urlMatch) return { type: 'url', value: urlMatch[0] }

  // Domain mention
  const domainMatch = sentence.match(DOMAIN_RE)
  if (domainMatch) return { type: 'domain', value: domainMatch[0].split('/')[0] }

  // Bracket reference [N]
  const bracketMatch = sentence.match(BRACKET_RE)
  if (bracketMatch) {
    const n = parseInt(bracketMatch[0].slice(1, -1), 10)
    return { type: 'bracket', value: bracketMatch[0], sourceIndex: n - 1 } // 1-based → 0-based
  }

  return null
}

/**
 * Find the source that best matches the citation.
 * Returns null if no source matches.
 */
function resolveSource(citation: CitationMatch, sources: ResearchSource[]): ResearchSource | null {
  if (sources.length === 0) return null

  if (citation.type === 'bracket') {
    const idx = citation.sourceIndex ?? 0
    return sources[idx] ?? null
  }

  // For URL and domain citations: find source whose URL/domain matches
  const citationLower = citation.value.toLowerCase()
  for (const src of sources) {
    const srcDomain = src.domain.toLowerCase()
    const srcUrl = src.url.toLowerCase()
    if (
      srcDomain.includes(citationLower) ||
      citationLower.includes(srcDomain) ||
      srcUrl.includes(citationLower) ||
      citationLower.includes(srcUrl.replace(/^https?:\/\//, '').split('/')[0])
    ) {
      return src
    }
  }
  return null
}

// ── Main referee function ─────────────────────────────────────────────────────

/**
 * Check the model's reply against the retrieved sources (Tier 1 heuristic).
 * Returns a ClaimVerdict for each sentence in the reply.
 * Pure string/regex — no IO, synchronous, < 5ms for typical replies.
 */
export function checkReply(reply: string, sources: ResearchSource[]): ClaimVerdict[] {
  if (!reply.trim()) return []

  const sentences = tokeniseSentences(reply)
  const verdicts: ClaimVerdict[] = []

  for (const sentence of sentences) {
    const citation = detectCitation(sentence)

    if (!citation) {
      // No citation — neutral, no badge
      verdicts.push({ sentence, verdict: 'uncited' })
      continue
    }

    const source = resolveSource(citation, sources)
    if (!source) {
      // Citation detected but can't match to a source — treat as unverified
      verdicts.push({ sentence, citedUrl: citation.value, verdict: 'unverified' })
      continue
    }

    // Cross-check: what fraction of key terms from the sentence appear in the source passage?
    const keyTerms = extractKeyTerms(sentence)
    const overlap = termOverlap(keyTerms, source.passage)

    if (overlap > 0.5) {
      verdicts.push({
        sentence,
        citedUrl: source.url,
        verdict: 'verified',
        matchedPassage: source.passage,
      })
    } else {
      verdicts.push({
        sentence,
        citedUrl: source.url,
        verdict: 'unverified',
      })
    }
  }

  return verdicts
}
