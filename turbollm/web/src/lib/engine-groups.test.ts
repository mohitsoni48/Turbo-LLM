import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  engineGroupKey,
  groupEngines,
  latestMemberId,
  memberToActivate,
  parseLlamaBuild,
  variantLabel,
} from './engine-groups'
import type { Engine } from './types'

function eng(over: Partial<Engine> & { id: string }): Engine {
  return {
    name: over.id,
    binPath: '',
    version: '',
    capabilities: { kvTypes: [], flags: [] },
    ...over,
  }
}

// Use a POSIX-style and a Windows-style path to confirm both separators parse.
const llamaCuda9608 = eng({ id: 'a', binPath: '/root/.turbollm/engines/llama.cpp-b9608-cuda/llama-server' })
const llamaCuda9736 = eng({ id: 'b', binPath: 'C:\\Users\\x\\.turbollm\\engines\\llama.cpp-b9736-cuda\\llama-server.exe' })
const turboquant = eng({ id: 'c', binPath: '/root/.turbollm/engines/turboquant/llama-server', version: 'tq1' })
const mlx = eng({ id: 'd', kind: 'mlx', binPath: '/usr/bin/mlx_lm.server' })
const userFork = eng({ id: 'e', name: 'My Fork', binPath: '/opt/ik_llama/server', kind: 'llama-server' })

test('engineGroupKey collapses official llama.cpp builds regardless of backend/tag', () => {
  assert.equal(engineGroupKey(llamaCuda9608), 'official-llama')
  assert.equal(engineGroupKey(llamaCuda9736), 'official-llama')
})

test('engineGroupKey maps pip engines to their kind', () => {
  assert.equal(engineGroupKey(mlx), 'mlx')
  assert.equal(engineGroupKey(eng({ id: 'v', kind: 'vllm' })), 'vllm')
  assert.equal(engineGroupKey(eng({ id: 'k', kind: 'koboldcpp' })), 'koboldcpp')
})

test('engineGroupKey detects TurboQuant by path', () => {
  assert.equal(engineGroupKey(turboquant), 'turboquant')
})

test('engineGroupKey gives user-added engines a distinct, unmerged key', () => {
  assert.equal(engineGroupKey(userFork), 'user:e')
  assert.notEqual(engineGroupKey(userFork), engineGroupKey(eng({ id: 'f', binPath: '/opt/other/server' })))
})

test('parseLlamaBuild extracts tag + backend from both separators', () => {
  assert.deepEqual(parseLlamaBuild(llamaCuda9608.binPath), { tag: 'b9608', backend: 'cuda' })
  assert.deepEqual(parseLlamaBuild(llamaCuda9736.binPath), { tag: 'b9736', backend: 'cuda' })
})

test('parseLlamaBuild returns null for non-official layouts', () => {
  assert.equal(parseLlamaBuild(turboquant.binPath), null)
  assert.equal(parseLlamaBuild(userFork.binPath), null)
})

test('variantLabel formats official builds as "<tag> · <BACKEND>"', () => {
  assert.equal(variantLabel(llamaCuda9736), 'b9736 · CUDA')
})

test('variantLabel falls back to version then name for non-official engines', () => {
  assert.equal(variantLabel(turboquant), 'tq1')
  assert.equal(variantLabel(userFork), 'My Fork')
})

test('latestMemberId picks the highest llama.cpp build number', () => {
  assert.equal(latestMemberId([llamaCuda9608, llamaCuda9736]), 'b')
  assert.equal(latestMemberId([llamaCuda9736, llamaCuda9608]), 'b')
})

test('latestMemberId is null when no tags parse', () => {
  assert.equal(latestMemberId([turboquant, mlx]), null)
})

test('groupEngines collapses two llama builds into one group, others stay separate', () => {
  const groups = groupEngines([llamaCuda9608, llamaCuda9736, turboquant, mlx])
  const official = groups.find((g) => g.key === 'official-llama')
  assert.ok(official)
  assert.equal(official!.members.length, 2)
  assert.equal(official!.label, 'llama.cpp')
  assert.equal(official!.latestId, 'b')
  assert.equal(groups.length, 3)
})

test('memberToActivate prefers the active member, then latest, then first', () => {
  const groups = groupEngines([llamaCuda9608, llamaCuda9736])
  const g = groups[0]
  assert.equal(memberToActivate(g, 'a')?.id, 'a') // active member kept
  assert.equal(memberToActivate(g, null)?.id, 'b') // none active → latest
  const noTags = groupEngines([turboquant, mlx]).find((x) => x.key === 'turboquant')!
  assert.equal(memberToActivate(noTags, null)?.id, 'c') // no latest → first
})
