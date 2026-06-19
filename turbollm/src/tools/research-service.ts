// F-021: deterministic retrieval service.
// Wraps the pluggable search provider (F-020) and scores/ranks/filters results
// without any LLM calls — pure string/math, fully testable.
import { searchProviderClient, searchConfigured, type SearchConfig, type FetchImpl } from './search-providers.js'

export interface ResearchQuery {
  query: string
  /** Signal to the model what kind of answer is needed. */
  intent?: string
  /** 'current' penalises results older than 90 days; 'any' is neutral. */
  freshness?: 'current' | 'any'
}

export interface ResearchResult {
  url: string
  title: string
  /** Best-matching sentence extracted from the raw search snippet. */
  passage: string
  /** 0.0–1.0 composite score: keyword overlap + domain signal + freshness. */
  relevanceScore: number
  freshnessSignal: 'recent' | 'dated' | 'unknown'
  /** Hostname extracted from url (e.g. "en.wikipedia.org"). */
  domain: string
}

const MIN_RELEVANCE_SCORE = 0.4
const MAX_RESULTS = 5
const MAX_SEARCH_RESULTS = 10

// ── Trusted / penalised domain map ────────────────────────────────────────────

/** Known high-quality TLDs/domains → score 0.8–1.0. */
const TRUSTED_DOMAINS: Array<[RegExp, number]> = [
  [/\.(edu|ac\.[a-z]{2})$/, 0.9],
  [/\.gov(\.[a-z]{2})?$/, 0.9],
  [/^(en|fr|de|es|ja|zh)\.wikipedia\.org$/, 1.0],
  [/^wikipedia\.org$/, 1.0],
  [/^(www\.)?(nature\.com|science\.org|pubmed\.ncbi\.nlm\.nih\.gov|arxiv\.org)$/, 0.95],
  [/^(www\.)?(nytimes\.com|reuters\.com|bbc\.com|bbc\.co\.uk|apnews\.com|theguardian\.com)$/, 0.85],
  [/^(www\.)?(wired\.com|techcrunch\.com|arstechnica\.com|theverge\.com)$/, 0.8],
  [/^(www\.)?(stackoverflow\.com|github\.com|docs\.python\.org|developer\.mozilla\.org)$/, 0.9],
  [/^(www\.)?(python\.org|nodejs\.org|typescriptlang\.org|rust-lang\.org)$/, 0.9],
]

/** Known low-quality/spam domains → score 0.1. */
const SPAM_DOMAINS: RegExp[] = [
  /^(www\.)?pinterest\.(com|co\.[a-z]{2})$/,
  /^(www\.)?quora\.com$/,
  /^(www\.)?reddit\.com\/r\/\w+\/comments\//, // deep reddit comment URLs
]

/** Extract the hostname from a URL. Returns '' on parse error. */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/**
 * Score a domain 0.1–1.0.
 * Trusted map first, spam list second, otherwise 0.5.
 */
export function domainScore(url: string): number {
  const host = new URL(url.startsWith('http') ? url : `https://${url}`).hostname
  // Check spam first (avoid false-positive on .edu spam)
  for (const re of SPAM_DOMAINS) {
    if (re.test(host)) return 0.1
  }
  for (const [re, score] of TRUSTED_DOMAINS) {
    if (re.test(host)) return score
  }
  // TLD-based fallbacks
  if (host.endsWith('.edu') || host.endsWith('.gov')) return 0.9
  return 0.5
}

// ── Keyword overlap ────────────────────────────────────────────────────────────

/** Short stop-word list to filter noise. */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been',
  'this', 'that', 'it', 'its', 'as', 'do', 'did', 'does', 'have', 'has',
  'had', 'not', 'no', 'so', 'if', 'up', 'out', 'can', 'will', 'just',
  'more', 'also', 'than', 'then', 'when', 'how', 'what', 'which', 'who',
])

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
}

/**
 * BM25-style keyword overlap: fraction of unique query terms found in text,
 * boosted by bigram overlap. Returns 0.0–1.0.
 */
export function keywordOverlap(query: string, text: string): number {
  const qTokens = tokenize(query)
  if (qTokens.length === 0) return 0
  const tTokens = new Set(tokenize(text))

  // Unigram fraction
  const unigramHits = qTokens.filter((t) => tTokens.has(t)).length
  const unigramScore = unigramHits / qTokens.length

  // Bigram bonus: how many consecutive query-term pairs also appear together in text
  const textStr = text.toLowerCase()
  let bigramHits = 0
  let bigramTotal = 0
  for (let i = 0; i < qTokens.length - 1; i++) {
    bigramTotal++
    if (textStr.includes(`${qTokens[i]} ${qTokens[i + 1]}`)) bigramHits++
  }
  const bigramScore = bigramTotal > 0 ? bigramHits / bigramTotal : 0

  // Weight unigrams 70%, bigrams 30%
  return Math.min(1, unigramScore * 0.7 + bigramScore * 0.3)
}

// ── Passage extraction ────────────────────────────────────────────────────────

/**
 * Return the sentence in `content` with the highest keyword overlap against `query`.
 * Falls back to the first 200 chars if no sentence boundary found.
 */
export function extractPassage(query: string, content: string): string {
  if (!content) return ''

  // Split on sentence-ending punctuation followed by whitespace or end of string
  const sentences = content.split(/(?<=[.?!])\s+/).filter((s) => s.trim().length > 0)
  if (sentences.length <= 1) {
    // No clear sentence boundaries — use first 200 chars
    return content.slice(0, 200)
  }

  let bestSentence = sentences[0]
  let bestScore = keywordOverlap(query, sentences[0])
  for (let i = 1; i < sentences.length; i++) {
    const s = keywordOverlap(query, sentences[i])
    if (s > bestScore) {
      bestScore = s
      bestSentence = sentences[i]
    }
  }
  return bestSentence.trim()
}

// ── Freshness signal ───────────────────────────────────────────────────────────

/**
 * Simple heuristic: scan the content for date-like strings and gauge recency.
 * Only penalises when `freshness: 'current'`.
 */
function freshnessSignal(content: string, freshness?: 'current' | 'any'): 'recent' | 'dated' | 'unknown' {
  if (!freshness || freshness === 'any') return 'unknown'

  // Look for year patterns in content
  const currentYear = new Date().getFullYear()
  const yearMatches = content.match(/\b(20\d{2})\b/g)
  if (!yearMatches) return 'unknown'

  const years = yearMatches.map(Number)
  const maxYear = Math.max(...years)
  if (maxYear >= currentYear - 1) return 'recent'
  if (maxYear <= currentYear - 3) return 'dated'
  return 'unknown'
}

function freshnessScore(signal: 'recent' | 'dated' | 'unknown', freshness?: 'current' | 'any'): number {
  if (!freshness || freshness === 'any') return 0.5 // neutral
  if (signal === 'recent') return 0.9
  if (signal === 'dated') return 0.2
  return 0.5 // unknown → neutral
}

// ── Main research function ────────────────────────────────────────────────────

/**
 * Run a web search via the configured provider, then deterministically score,
 * rank, filter (≥0.4), and cap (top 5) the results. Returns ResearchResult[].
 * Returns [] if the provider is not configured.
 */
export async function research(
  q: ResearchQuery,
  cfg: SearchConfig,
  fetchImpl?: FetchImpl,
): Promise<ResearchResult[]> {
  if (!searchConfigured(cfg)) return []

  const client = searchProviderClient(cfg, fetchImpl)
  if (!client) return []

  let raw
  try {
    raw = await client.search(q.query, MAX_SEARCH_RESULTS)
  } catch {
    return []
  }

  const scored: ResearchResult[] = raw.map((r) => {
    const domain = extractDomain(r.url)
    const text = `${r.title} ${r.content}`
    const kwScore = keywordOverlap(q.query, text)
    const ds = domainScore(r.url)
    const signal = freshnessSignal(r.content, q.freshness)
    const fs = freshnessScore(signal, q.freshness)
    const relevanceScore = 0.5 * kwScore + 0.3 * ds + 0.2 * fs
    const passage = extractPassage(q.query, r.content)

    return {
      url: r.url,
      title: r.title,
      passage,
      relevanceScore: Math.round(relevanceScore * 1000) / 1000,
      freshnessSignal: signal,
      domain,
    }
  })

  return scored
    .filter((r) => r.relevanceScore >= MIN_RELEVANCE_SCORE)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, MAX_RESULTS)
}
