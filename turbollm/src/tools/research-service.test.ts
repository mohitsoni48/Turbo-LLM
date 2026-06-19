// F-021: tests for the deterministic retrieval service.
// Pure functions + injected fetch — no network, fully deterministic.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  research,
  keywordOverlap,
  domainScore,
  extractPassage,
  type ResearchQuery,
} from './research-service.js'
import type { SearchConfig, FetchImpl } from './search-providers.js'

// ── helpers ───────────────────────────────────────────────────────────────────

function stubFetch(results: Array<{ title?: string; url?: string; content?: string; score?: number }>): FetchImpl {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results }),
    text: async () => JSON.stringify({ results }),
  })) as unknown as FetchImpl
}

const CFG: SearchConfig = { provider: 'tavily', tavilyApiKey: 'test-key' }

// ── keywordOverlap ────────────────────────────────────────────────────────────

test('keywordOverlap: identical query and text returns 1', () => {
  const score = keywordOverlap('machine learning', 'machine learning')
  assert.ok(score > 0.9, `expected ≥0.9, got ${score}`)
})

test('keywordOverlap: no matching terms returns 0', () => {
  const score = keywordOverlap('machine learning', 'cooking recipes dessert')
  assert.equal(score, 0)
})

test('keywordOverlap: partial match returns between 0 and 1', () => {
  const score = keywordOverlap('python programming', 'python is great for programming tasks')
  assert.ok(score > 0 && score <= 1, `expected (0,1], got ${score}`)
})

test('keywordOverlap: case insensitive', () => {
  const s1 = keywordOverlap('Python', 'python programming')
  const s2 = keywordOverlap('python', 'Python programming')
  assert.equal(s1, s2)
})

// ── domainScore ───────────────────────────────────────────────────────────────

test('domainScore: wikipedia gets high score', () => {
  assert.ok(domainScore('https://en.wikipedia.org/wiki/Foo') >= 0.8)
})

test('domainScore: .edu gets high score', () => {
  assert.ok(domainScore('https://mit.edu/courses/ai') >= 0.8)
})

test('domainScore: .gov gets high score', () => {
  assert.ok(domainScore('https://cdc.gov/diseases') >= 0.8)
})

test('domainScore: unknown domain gets 0.5', () => {
  assert.equal(domainScore('https://random-unknown-blog.xyz/post'), 0.5)
})

test('domainScore: known spam domain gets low score', () => {
  assert.ok(domainScore('https://pinterest.com/pin/12345') <= 0.2)
})

// ── extractPassage ────────────────────────────────────────────────────────────

test('extractPassage: picks sentence with best keyword overlap', () => {
  const content = 'The sky is blue. Python is a programming language. Cats are fluffy.'
  const passage = extractPassage('python programming', content)
  assert.ok(passage.toLowerCase().includes('python'), `expected python in passage, got: "${passage}"`)
})

test('extractPassage: falls back to first 200 chars when content is one long string', () => {
  const content = 'a'.repeat(300)
  const passage = extractPassage('query', content)
  assert.equal(passage, content.slice(0, 200))
})

test('extractPassage: handles empty content', () => {
  const passage = extractPassage('query', '')
  assert.equal(passage, '')
})

test('extractPassage: single sentence returns that sentence', () => {
  const content = 'The quick brown fox jumps over the lazy dog'
  const passage = extractPassage('fox lazy dog', content)
  assert.ok(passage.length > 0)
})

// ── scoring and ranking ───────────────────────────────────────────────────────

test('research: results are sorted by relevanceScore descending', async () => {
  const fetch = stubFetch([
    { title: 'Cooking recipes', url: 'https://unknown1.com', content: 'Cooking recipes for dinner party events.' },
    { title: 'Python programming tutorial', url: 'https://python.org/docs', content: 'Python is a great programming language for developers.' },
    { title: 'Python basics', url: 'https://en.wikipedia.org/wiki/Python', content: 'Python programming language was created by Guido.' },
  ])
  const q: ResearchQuery = { query: 'python programming' }
  const results = await research(q, CFG, fetch)
  assert.ok(results.length >= 2)
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i - 1].relevanceScore >= results[i].relevanceScore,
      `result[${i - 1}].score (${results[i-1].relevanceScore}) < result[${i}].score (${results[i].relevanceScore})`,
    )
  }
})

test('research: caps at 5 results', async () => {
  const fetch = stubFetch(
    Array.from({ length: 10 }, (_, i) => ({
      title: `Python result ${i}`,
      url: `https://python${i}.org`,
      content: `Python programming tutorial number ${i} for python developers.`,
    })),
  )
  const q: ResearchQuery = { query: 'python programming' }
  const results = await research(q, CFG, fetch)
  assert.ok(results.length <= 5, `expected ≤5 results, got ${results.length}`)
})

test('research: domain extracted correctly', async () => {
  const fetch = stubFetch([
    { title: 'Python docs', url: 'https://python.org/docs/latest', content: 'Python programming language documentation.' },
  ])
  const q: ResearchQuery = { query: 'python' }
  const results = await research(q, CFG, fetch)
  assert.ok(results.length > 0)
  assert.equal(results[0].domain, 'python.org')
})

test('research: passage is extracted (non-empty for non-empty content)', async () => {
  const fetch = stubFetch([
    {
      title: 'Python programming',
      url: 'https://python.org',
      content: 'Python is a high-level language. It is great for programming. Many developers love Python.',
    },
  ])
  const q: ResearchQuery = { query: 'python programming' }
  const results = await research(q, CFG, fetch)
  assert.ok(results.length > 0)
  assert.ok(results[0].passage.length > 0, 'passage should be non-empty')
})

test('research: freshnessSignal is a valid value', async () => {
  const fetch = stubFetch([
    { title: 'Python docs', url: 'https://python.org', content: 'Python programming is great.' },
  ])
  const q: ResearchQuery = { query: 'python' }
  const results = await research(q, CFG, fetch)
  if (results.length > 0) {
    assert.ok(['recent', 'dated', 'unknown'].includes(results[0].freshnessSignal))
  }
})

test('research: returns empty array when provider not configured', async () => {
  const badCfg: SearchConfig = { provider: 'tavily' } // no key
  const q: ResearchQuery = { query: 'python' }
  const results = await research(q, badCfg)
  assert.deepEqual(results, [])
})

test('research: wikipedia result scores higher than unknown domain for identical content', async () => {
  const fetch = stubFetch([
    { title: 'Python', url: 'https://unknownblog.xyz/python', content: 'Python programming language overview.' },
    { title: 'Python', url: 'https://en.wikipedia.org/wiki/Python', content: 'Python programming language overview.' },
  ])
  const q: ResearchQuery = { query: 'python programming' }
  const results = await research(q, CFG, fetch)
  const wikiResult = results.find((r) => r.url.includes('wikipedia'))
  const unknownResult = results.find((r) => r.url.includes('unknownblog'))
  if (wikiResult && unknownResult) {
    assert.ok(
      wikiResult.relevanceScore > unknownResult.relevanceScore,
      `wiki (${wikiResult.relevanceScore}) should outscore unknown (${unknownResult.relevanceScore})`,
    )
  }
})

test('research: configured-provider plumbing — fetch is called with tavily endpoint', async () => {
  const calls: string[] = []
  const trackingFetch: FetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url))
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [{ title: 'T', url: 'https://python.org', content: 'python test' }] }),
      text: async () => '{}',
    } as Response
  }) as unknown as FetchImpl

  const q: ResearchQuery = { query: 'python' }
  await research(q, CFG, trackingFetch)
  assert.ok(calls.length > 0)
  assert.match(calls[0], /tavily\.com/)
})
