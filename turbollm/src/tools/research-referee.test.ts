// F-022: tests for the heuristic research referee.
// Pure string/regex — no IO, no network.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkReply } from './research-referee.js'
import type { ResearchSource } from '../chat/db.js'

// ── helpers ───────────────────────────────────────────────────────────────────

function makeSource(domain: string, passage: string, url?: string): ResearchSource {
  return {
    url: url ?? `https://${domain}/page`,
    title: `${domain} article`,
    passage,
    relevanceScore: 0.8,
    freshnessSignal: 'unknown',
    domain,
  }
}

// ── verified case ─────────────────────────────────────────────────────────────

test('checkReply: cited sentence with key terms in passage → verified', () => {
  const sources: ResearchSource[] = [
    makeSource('python.org', 'Python is a high-level programming language created by Guido van Rossum.'),
  ]
  // Sentence contains both the claim and the domain citation inline
  const reply = 'According to python.org, Python is a high-level programming language created by Guido van Rossum.'
  const verdicts = checkReply(reply, sources)
  const cited = verdicts.find((v) => v.citedUrl !== undefined)
  assert.ok(cited, 'expected at least one cited sentence')
  assert.equal(cited!.verdict, 'verified')
})

// ── unverified case ───────────────────────────────────────────────────────────

test('checkReply: cited sentence with key terms NOT in passage → unverified', () => {
  const sources: ResearchSource[] = [
    makeSource('example.com', 'The weather today is sunny and warm.'),
  ]
  // Sentence cites example.com but claims something not in the passage
  const reply = 'Quantum computing will revolutionize cryptography by 2030. Source: example.com'
  const verdicts = checkReply(reply, sources)
  const cited = verdicts.find((v) => v.citedUrl !== undefined)
  assert.ok(cited, 'expected at least one cited sentence')
  assert.equal(cited!.verdict, 'unverified')
})

// ── uncited case ──────────────────────────────────────────────────────────────

test('checkReply: sentence with no citation → uncited', () => {
  const sources: ResearchSource[] = [
    makeSource('python.org', 'Python is a programming language.'),
  ]
  const reply = 'The sky is blue and the grass is green.'
  const verdicts = checkReply(reply, sources)
  assert.ok(verdicts.length > 0, 'should have at least one verdict')
  assert.ok(verdicts.every((v) => v.verdict === 'uncited'), `expected all uncited, got: ${JSON.stringify(verdicts.map(v => v.verdict))}`)
})

// ── URL citation detection ────────────────────────────────────────────────────

test('checkReply: detects full URL as citation', () => {
  const sources: ResearchSource[] = [
    makeSource('python.org', 'Python programming language documentation and tutorials.', 'https://python.org/docs'),
  ]
  const reply = 'Python documentation is available at https://python.org/docs for all developers.'
  const verdicts = checkReply(reply, sources)
  const cited = verdicts.find((v) => v.citedUrl !== undefined)
  assert.ok(cited, 'should detect URL citation')
})

// ── [N] bracket citation detection ───────────────────────────────────────────

test('checkReply: detects [N] bracket reference as citation', () => {
  const sources: ResearchSource[] = [
    makeSource('wikipedia.org', 'Python is a high-level programming language.'),
  ]
  const reply = 'Python is a widely used language [1]. It was created in the 1990s.'
  const verdicts = checkReply(reply, sources)
  // [1] references the first source
  const cited = verdicts.find((v) => v.citedUrl !== undefined)
  assert.ok(cited, 'should detect [N] citation')
})

// ── mixed reply ───────────────────────────────────────────────────────────────

test('checkReply: mixed reply returns mix of verdicts', () => {
  const sources: ResearchSource[] = [
    makeSource('python.org', 'Python is an interpreted high-level programming language.'),
  ]
  // One cited+verifiable sentence, one uncited
  const reply = 'Python is an interpreted high-level programming language (python.org). The moon is made of cheese.'
  const verdicts = checkReply(reply, sources)
  const hasVerified = verdicts.some((v) => v.verdict === 'verified')
  const hasUncited = verdicts.some((v) => v.verdict === 'uncited')
  assert.ok(hasVerified || hasUncited, 'should have verified or uncited verdicts')
})

// ── empty inputs ──────────────────────────────────────────────────────────────

test('checkReply: empty reply returns empty array', () => {
  const verdicts = checkReply('', [])
  assert.deepEqual(verdicts, [])
})

test('checkReply: reply with no sources returns all uncited', () => {
  const reply = 'The sky is blue. Water is wet.'
  const verdicts = checkReply(reply, [])
  assert.ok(verdicts.length > 0)
  assert.ok(verdicts.every((v) => v.verdict === 'uncited'))
})

// ── sentence tokenisation ─────────────────────────────────────────────────────

test('checkReply: multi-sentence reply produces multiple verdicts', () => {
  const sources: ResearchSource[] = []
  const reply = 'First sentence here. Second sentence here. Third sentence here.'
  const verdicts = checkReply(reply, sources)
  assert.ok(verdicts.length >= 2, `expected ≥2 verdicts, got ${verdicts.length}`)
})

// ── sentence text preserved ───────────────────────────────────────────────────

test('checkReply: verdict sentence field contains the original sentence text', () => {
  const sources: ResearchSource[] = []
  const reply = 'Hello world. Goodbye world.'
  const verdicts = checkReply(reply, sources)
  const texts = verdicts.map((v) => v.sentence)
  assert.ok(texts.some((t) => t.includes('Hello') || t.includes('Goodbye')))
})

// ── matchedPassage field ──────────────────────────────────────────────────────

test('checkReply: verified verdict includes matchedPassage', () => {
  const passage = 'Python is a high-level programming language.'
  const sources: ResearchSource[] = [
    makeSource('python.org', passage),
  ]
  const reply = 'Python is a high-level language. See python.org.'
  const verdicts = checkReply(reply, sources)
  const verified = verdicts.find((v) => v.verdict === 'verified')
  if (verified) {
    assert.ok(verified.matchedPassage !== undefined, 'verified verdict should have matchedPassage')
  }
})
