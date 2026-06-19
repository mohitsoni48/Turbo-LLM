// BUG-001 regression tests: Qwen3 / thinking models returning only <think>...</think>
// tokens after the tool-calling loop, leaving visible content empty.
//
// The fix: after the tool loop exits, strip <think> blocks from the accumulated
// content. If the visible content is empty/whitespace, make one extra inference
// pass with tool_choice:'none' and use that result as the final reply.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { stripThinkingBlocks, needsExtraPass } from './think-utils.js'

// ── stripThinkingBlocks ───────────────────────────────────────────────────────

test('stripThinkingBlocks: removes a single <think> block', () => {
  const input = '<think>some chain of thought</think>The actual answer.'
  assert.equal(stripThinkingBlocks(input), 'The actual answer.')
})

test('stripThinkingBlocks: removes multiple <think> blocks', () => {
  const input = '<think>step 1</think>middle<think>step 2</think>end'
  assert.equal(stripThinkingBlocks(input), 'middleend')
})

test('stripThinkingBlocks: case-insensitive tag match', () => {
  const input = '<THINK>hidden</THINK>visible'
  assert.equal(stripThinkingBlocks(input), 'visible')
})

test('stripThinkingBlocks: multiline think block is removed', () => {
  const input = '<think>\nline one\nline two\n</think>\nFinal answer.'
  assert.equal(stripThinkingBlocks(input).trim(), 'Final answer.')
})

test('stripThinkingBlocks: no think block returns input unchanged', () => {
  const input = 'Plain response with no thinking.'
  assert.equal(stripThinkingBlocks(input), input)
})

test('stripThinkingBlocks: only think block yields empty string after trim', () => {
  const input = '<think>only reasoning, no visible content</think>'
  assert.equal(stripThinkingBlocks(input).trim(), '')
})

test('stripThinkingBlocks: whitespace-only after stripping yields empty after trim', () => {
  const input = '<think>reasoning</think>   \n  '
  assert.equal(stripThinkingBlocks(input).trim(), '')
})

// ── needsExtraPass ───────────────────────────────────────────────────────────

test('needsExtraPass: returns true when content is only a <think> block', () => {
  assert.equal(needsExtraPass('<think>deep thoughts</think>'), true)
})

test('needsExtraPass: returns true when content is whitespace only', () => {
  assert.equal(needsExtraPass('   \n\t  '), true)
})

test('needsExtraPass: returns true when content is empty string', () => {
  assert.equal(needsExtraPass(''), true)
})

test('needsExtraPass: returns false when visible content exists after stripping', () => {
  assert.equal(needsExtraPass('<think>reasoning</think>Here is my answer.'), false)
})

test('needsExtraPass: returns false for plain text with no thinking tokens', () => {
  assert.equal(needsExtraPass('The capital of France is Paris.'), false)
})

test('needsExtraPass: returns false when think block is followed by non-whitespace', () => {
  assert.equal(needsExtraPass('<think>step</think>\n\nActual answer here.'), false)
})
