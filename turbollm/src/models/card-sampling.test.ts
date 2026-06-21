import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseCardSampling,
  clampCardSampling,
  hasAnySampling,
  parseLlmSampling,
  buildCardExtractionPrompt,
  type CardSampling,
} from './card-sampling'

// ─── heuristic parse ─────────────────────────────────────────────────────────

test('parseCardSampling: inline recommended-settings line', () => {
  const card = 'We recommend using temperature=0.6, top_p=0.95, top_k=20, min_p=0 for best results.'
  assert.deepEqual(parseCardSampling(card), { temp: 0.6, topP: 0.95, topK: 20, minP: 0 })
})

test('parseCardSampling: markdown table (Qwen-style)', () => {
  const card = [
    '## Best Practices',
    '| Setting | Value |',
    '|---|---|',
    '| Temperature | 0.7 |',
    '| Top-P | 0.8 |',
    '| Top-K | 20 |',
    '| Min-P | 0 |',
  ].join('\n')
  assert.deepEqual(parseCardSampling(card), { temp: 0.7, topP: 0.8, topK: 20, minP: 0 })
})

test('parseCardSampling: bold/colon and leading-dot decimals', () => {
  const card = '**Temperature:** 0.8\n**top_p:** .95\n**Top K**: 40'
  assert.deepEqual(parseCardSampling(card), { temp: 0.8, topP: 0.95, topK: 40 })
})

test('parseCardSampling: partial card (only some knobs stated)', () => {
  // Only temperature is stated in a parseable `name <sep> value` form; the rest are absent.
  assert.deepEqual(parseCardSampling('Recommended: temperature 0.5. Leave other settings at default.'), { temp: 0.5 })
})

test('parseCardSampling: prose-only with no numbers → empty (LLM fallback territory)', () => {
  assert.deepEqual(parseCardSampling('Use a low temperature and a high top-p for creative output.'), {})
})

test('parseCardSampling: out-of-range values are dropped, not clamped', () => {
  // temp 5 (>2), top_p 1.5 (>1) are mis-parses / non-recommendations → dropped; top_k 40 kept.
  assert.deepEqual(parseCardSampling('temperature: 5  top_p: 1.5  top_k: 40'), { topK: 40 })
})

test('parseCardSampling: does not match lookalike words (laptop / attempt / temporary)', () => {
  assert.deepEqual(parseCardSampling('On a laptop, the first attempt is temporary; see section 3.'), {})
})

test('parseCardSampling: empty / missing card → empty', () => {
  assert.deepEqual(parseCardSampling(''), {})
})

test('parseCardSampling: ignores values inside fenced code blocks (usage demos ≠ recommendations)', () => {
  // Verified live against Mistral-7B: `temperature=0` lives in a usage snippet, not a
  // recommendation — it must NOT be extracted (would fall through to the LLM fallback).
  const card = [
    'Here is how to use it:',
    '```python',
    'pipe(messages, temperature=0, top_p=1.0)',
    '```',
    'That is all.',
  ].join('\n')
  assert.deepEqual(parseCardSampling(card), {})
})

test('parseCardSampling: real recommendation in a table survives alongside a code example', () => {
  const card = [
    '| Temperature | 0.6 |',
    '| Top-P | 0.95 |',
    '```python',
    'generate(temperature=0.0)  # demo only',
    '```',
  ].join('\n')
  assert.deepEqual(parseCardSampling(card), { temp: 0.6, topP: 0.95 })
})

test('parseCardSampling: min_p of 0 is kept (presence, not truthiness)', () => {
  const r = parseCardSampling('min_p = 0')
  assert.equal(r.minP, 0)
  assert.equal(hasAnySampling(r), true)
})

// ─── clamp ───────────────────────────────────────────────────────────────────

test('clampCardSampling: rounds top_k, drops out-of-range + non-finite', () => {
  const dirty: CardSampling = { temp: 0.6, topP: 2, topK: 19.6, minP: Number.NaN }
  // topP 2 (>1) dropped; topK rounded to 20; minP NaN dropped; temp kept.
  assert.deepEqual(clampCardSampling(dirty), { temp: 0.6, topK: 20 })
})

// ─── hasAnySampling ──────────────────────────────────────────────────────────

test('hasAnySampling: false on empty, true on any present (incl. 0)', () => {
  assert.equal(hasAnySampling({}), false)
  assert.equal(hasAnySampling({ minP: 0 }), true)
  assert.equal(hasAnySampling({ temp: 0.7 }), true)
})

// ─── LLM fallback JSON parse ─────────────────────────────────────────────────

test('parseLlmSampling: plain JSON object', () => {
  const r = parseLlmSampling('{"temperature":0.6,"top_k":20,"top_p":0.95,"min_p":0.05}')
  assert.deepEqual(r, { temp: 0.6, topK: 20, topP: 0.95, minP: 0.05 })
})

test('parseLlmSampling: fenced JSON with surrounding prose', () => {
  const text = 'Here are the settings:\n```json\n{"temperature": 0.7, "top_p": 0.8, "top_k": null, "min_p": null}\n```\nHope this helps.'
  assert.deepEqual(parseLlmSampling(text), { temp: 0.7, topP: 0.8 })
})

test('parseLlmSampling: numeric strings coerced; out-of-range dropped', () => {
  const r = parseLlmSampling('{"temperature":"0.5","top_k":"40","top_p":3,"min_p":null}')
  assert.deepEqual(r, { temp: 0.5, topK: 40 }) // top_p 3 dropped, min_p null absent
})

test('parseLlmSampling: non-JSON / garbage → empty, never throws', () => {
  assert.deepEqual(parseLlmSampling('I could not find any recommended settings.'), {})
  assert.deepEqual(parseLlmSampling('{ not valid json '), {})
  assert.deepEqual(parseLlmSampling(''), {})
})

// ─── prompt builder ──────────────────────────────────────────────────────────

test('buildCardExtractionPrompt: embeds (capped) card + asks for JSON-only', () => {
  const prompt = buildCardExtractionPrompt('x'.repeat(20000))
  assert.match(prompt, /ONLY a single JSON object/)
  assert.match(prompt, /"temperature": number\|null/)
  // card capped at 8000 chars, so the whole prompt stays well under the full 20k input.
  assert.ok(prompt.length < 9000)
})
