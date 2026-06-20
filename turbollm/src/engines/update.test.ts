import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseBuildTag,
  compareBuildTags,
  parsePipVersion,
  comparePipVersions,
  compareVersions,
  decideAutoUpdate,
  normalizeUpdatePolicy,
  resolveUpdateSource,
  tagFromManagedBinPath,
  tagFromVersionString,
  versionFromPipString,
  computeUpdateStatus,
  UpdateChecker,
  type ResolvedSource,
} from './update'
import type { Engine } from '../config/config'
import { engineIsIdle } from './update-scheduler'
import type { Manager } from './manager'

// ─── build-tag comparison ────────────────────────────────────────────────────

test('parseBuildTag: parses b<number>, tolerates case/whitespace/leading v', () => {
  assert.equal(parseBuildTag('b9608'), 9608)
  assert.equal(parseBuildTag('B9761'), 9761)
  assert.equal(parseBuildTag('  b42 '), 42)
  assert.equal(parseBuildTag('vb1234'), 1234)
})

test('parseBuildTag: returns null for non-build-tag shapes', () => {
  assert.equal(parseBuildTag('1.2.3'), null)
  assert.equal(parseBuildTag('latest'), null)
  assert.equal(parseBuildTag('b'), null)
  assert.equal(parseBuildTag('bxyz'), null)
  assert.equal(parseBuildTag(''), null)
})

test('compareBuildTags: equal / newer / older', () => {
  assert.equal(compareBuildTags('b9608', 'b9608'), 'equal')
  assert.equal(compareBuildTags('b9608', 'b9761'), 'newer') // latest is ahead
  assert.equal(compareBuildTags('b9761', 'b9608'), 'older') // latest is behind
})

test('compareBuildTags: malformed on either side → unknown', () => {
  assert.equal(compareBuildTags('b9608', 'latest'), 'unknown')
  assert.equal(compareBuildTags('1.2.3', 'b9761'), 'unknown')
  assert.equal(compareBuildTags('', ''), 'unknown')
})

// ─── pip version comparison ──────────────────────────────────────────────────

test('parsePipVersion: leading dotted-integer release, ignores suffixes', () => {
  assert.deepEqual(parsePipVersion('0.11.2'), [0, 11, 2])
  assert.deepEqual(parsePipVersion('1.2.3rc1+cu124'), [1, 2, 3])
  assert.deepEqual(parsePipVersion('v2.0'), [2, 0])
  assert.equal(parsePipVersion('not-a-version'), null)
})

test('comparePipVersions: equal (incl. trailing-zero), newer, older', () => {
  assert.equal(comparePipVersions('0.11.0', '0.11'), 'equal')
  assert.equal(comparePipVersions('0.11.2', '0.12.0'), 'newer')
  assert.equal(comparePipVersions('0.31.2', '0.31.1'), 'older')
  assert.equal(comparePipVersions('1.0', '2.0'), 'newer')
})

test('comparePipVersions: unparseable side → unknown', () => {
  assert.equal(comparePipVersions('0.11.2', 'unknown'), 'unknown')
  assert.equal(comparePipVersions('weird', '0.1'), 'unknown')
})

test('compareVersions: routes by source', () => {
  assert.equal(compareVersions('github-release', 'b1', 'b2'), 'newer')
  assert.equal(compareVersions('pip', '0.1.0', '0.2.0'), 'newer')
  assert.equal(compareVersions('pip', '0.2.0', '0.1.0'), 'older')
})

// ─── decideAutoUpdate truth table ────────────────────────────────────────────

test('decideAutoUpdate: only auto && hasUpdate && idle applies', () => {
  // auto
  assert.equal(decideAutoUpdate({ policy: 'auto', hasUpdate: true, idle: true }), true)
  assert.equal(decideAutoUpdate({ policy: 'auto', hasUpdate: true, idle: false }), false) // busy waits
  assert.equal(decideAutoUpdate({ policy: 'auto', hasUpdate: false, idle: true }), false) // nothing to do
  // notify never applies
  assert.equal(decideAutoUpdate({ policy: 'notify', hasUpdate: true, idle: true }), false)
  assert.equal(decideAutoUpdate({ policy: 'notify', hasUpdate: true, idle: false }), false)
  // off never applies
  assert.equal(decideAutoUpdate({ policy: 'off', hasUpdate: true, idle: true }), false)
  assert.equal(decideAutoUpdate({ policy: 'off', hasUpdate: true, idle: false }), false)
})

test('normalizeUpdatePolicy: defaults to notify, preserves off/auto', () => {
  assert.equal(normalizeUpdatePolicy(undefined), 'notify')
  assert.equal(normalizeUpdatePolicy('garbage'), 'notify')
  assert.equal(normalizeUpdatePolicy('notify'), 'notify')
  assert.equal(normalizeUpdatePolicy('off'), 'off')
  assert.equal(normalizeUpdatePolicy('auto'), 'auto')
})

// ─── installed-version extraction ────────────────────────────────────────────

test('tagFromManagedBinPath: extracts the build tag from a tag-keyed dir', () => {
  assert.equal(
    tagFromManagedBinPath('/home/u/.turbollm/engines/llama.cpp-b9608-cuda/llama-server'),
    'b9608',
  )
  assert.equal(
    tagFromManagedBinPath('C:\\Users\\u\\.turbollm\\engines\\llama.cpp-b9761-vulkan\\llama-server.exe'),
    'b9761',
  )
  assert.equal(tagFromManagedBinPath('/some/user/path/llama-server'), '')
})

test('tagFromVersionString: pulls a b<number> tag out of a probe string', () => {
  assert.equal(tagFromVersionString('version: 1.2.3 (b9608)'), 'b9608')
  assert.equal(tagFromVersionString('llama-server build b9761 commit abc'), 'b9761')
  assert.equal(tagFromVersionString('no build tag here'), '')
})

test('versionFromPipString: strips the package label', () => {
  assert.equal(versionFromPipString('mlx-lm 0.31.2'), '0.31.2')
  assert.equal(versionFromPipString('vllm 0.11.2'), '0.11.2')
  assert.equal(versionFromPipString('0.9.0'), '0.9.0')
})

// ─── resolveUpdateSource ─────────────────────────────────────────────────────

function eng(partial: Partial<Engine>): Engine {
  return {
    id: 'e1',
    name: 'x',
    binPath: '/p/llama-server',
    kind: 'llama-server',
    version: '',
    capabilities: { kvTypes: [], flags: [] },
    addedAt: '2026-01-01T00:00:00Z',
    ...partial,
  }
}

test('resolveUpdateSource: managed official llama.cpp → ggml-org repo + tag from path', () => {
  const src = resolveUpdateSource(
    eng({ binPath: '/root/engines/llama.cpp-b9608-cuda/llama-server', version: 'version: b9608' }),
  )
  assert.deepEqual(src, { source: 'github-release', ref: 'ggml-org/llama.cpp', installed: 'b9608' })
})

test('resolveUpdateSource: turboquant fork → fork repo + tag from version', () => {
  const src = resolveUpdateSource(
    eng({ binPath: '/root/engines/turboquant/llama-server', version: 'build b9000' }),
  )
  assert.equal(src?.source, 'github-release')
  assert.equal(src?.ref, 'AtomicBot-ai/atomic-llama-cpp-turboquant')
  assert.equal(src?.installed, 'b9000')
})

test('resolveUpdateSource: mlx/vllm → PyPI package + stripped version', () => {
  assert.deepEqual(resolveUpdateSource(eng({ kind: 'mlx', version: 'mlx-lm 0.31.2' })), {
    source: 'pip',
    ref: 'mlx-lm',
    installed: '0.31.2',
  })
  assert.deepEqual(resolveUpdateSource(eng({ kind: 'vllm', version: 'vllm 0.11.2' })), {
    source: 'pip',
    ref: 'vllm',
    installed: '0.11.2',
  })
})

test('resolveUpdateSource: user-added arbitrary binary → null (no honest source)', () => {
  assert.equal(resolveUpdateSource(eng({ binPath: '/opt/my/llama-server', version: 'b9608' })), null)
})

// ─── computeUpdateStatus: no false latest on error ───────────────────────────

test('computeUpdateStatus: hasUpdate true when latest is newer', async () => {
  const e = eng({ binPath: '/root/engines/llama.cpp-b9608-cuda/llama-server' })
  const st = await computeUpdateStatus(e, async () => 'b9761')
  assert.equal(st.installed, 'b9608')
  assert.equal(st.latest, 'b9761')
  assert.equal(st.hasUpdate, true)
  assert.equal(st.comparable, true)
  assert.equal(st.error, undefined)
})

test('computeUpdateStatus: up to date → hasUpdate false', async () => {
  const e = eng({ binPath: '/root/engines/llama.cpp-b9761-cuda/llama-server' })
  const st = await computeUpdateStatus(e, async () => 'b9761')
  assert.equal(st.hasUpdate, false)
  assert.equal(st.latest, 'b9761')
  assert.equal(st.comparable, true)
})

test('computeUpdateStatus: network failure NEVER fabricates a latest', async () => {
  const e = eng({ binPath: '/root/engines/llama.cpp-b9608-cuda/llama-server' })
  const st = await computeUpdateStatus(e, async () => {
    throw new Error('getaddrinfo ENOTFOUND')
  })
  assert.equal(st.latest, null)
  assert.equal(st.hasUpdate, false)
  assert.equal(st.error, 'offline')
  assert.ok(st.checkedAt) // timestamp always present
})

test('computeUpdateStatus: empty latest treated as offline (no false up-to-date)', async () => {
  const e = eng({ kind: 'vllm', version: 'vllm 0.11.2' })
  const st = await computeUpdateStatus(e, async () => '')
  assert.equal(st.latest, null)
  assert.equal(st.hasUpdate, false)
  assert.equal(st.error, 'offline')
})

test('computeUpdateStatus: unparseable latest → comparable false, not hasUpdate', async () => {
  const e = eng({ binPath: '/root/engines/llama.cpp-b9608-cuda/llama-server' })
  const st = await computeUpdateStatus(e, async () => 'mystery-tag')
  assert.equal(st.latest, 'mystery-tag')
  assert.equal(st.hasUpdate, false)
  assert.equal(st.comparable, false)
})

test('computeUpdateStatus: no source → no_source error, no false latest', async () => {
  const e = eng({ binPath: '/opt/my/llama-server', version: 'b9608' })
  const st = await computeUpdateStatus(e, async () => 'b9999')
  assert.equal(st.latest, null)
  assert.equal(st.error, 'no_source')
  assert.equal(st.hasUpdate, false)
})

// ─── UpdateChecker cache: keeps last good answer over a later offline ─────────

test('UpdateChecker: an offline re-check keeps the prior successful status', async () => {
  const e = eng({ binPath: '/root/engines/llama.cpp-b9608-cuda/llama-server' })
  let mode: 'ok' | 'fail' = 'ok'
  const checker = new UpdateChecker(async () => {
    if (mode === 'fail') throw new Error('offline')
    return 'b9761'
  })
  const first = await checker.check(e)
  assert.equal(first.latest, 'b9761')
  assert.equal(first.hasUpdate, true)

  mode = 'fail'
  const second = await checker.check(e)
  // Keeps the last real answer rather than flapping to "couldn't check".
  assert.equal(second.latest, 'b9761')
  assert.equal(second.hasUpdate, true)
  assert.equal(checker.get(e.id)?.latest, 'b9761')
})

test('UpdateChecker: offline with no prior success caches the offline state', async () => {
  const e = eng({ kind: 'mlx', version: 'mlx-lm 0.31.2' })
  const checker = new UpdateChecker(async () => {
    throw new Error('offline')
  })
  const st = await checker.check(e)
  assert.equal(st.error, 'offline')
  assert.equal(st.latest, null)
})

// ─── scheduler idle gate (auto-apply only when not generating) ───────────────

/** Minimal Manager stub exposing only the surface engineIsIdle reads. */
function managerStub(state: string, activeRequests = 0): Manager {
  return {
    status: () => ({ state, err: null, port: 0, pid: 0, model: null, loadElapsedMs: 0 }),
    sessionStats: () => ({
      requests: 0, inputTokens: 0, outputTokens: 0, avgPromptTps: 0, avgGenTps: 0, sinceMs: 0, activeRequests,
    }),
  } as unknown as Manager
}

test('engineIsIdle: stopped/running-idle are idle; starting/stopping/generating are not', () => {
  assert.equal(engineIsIdle(managerStub('stopped')), true)
  assert.equal(engineIsIdle(managerStub('error')), true)
  assert.equal(engineIsIdle(managerStub('running', 0)), true)
  assert.equal(engineIsIdle(managerStub('running', 2)), false) // mid-generation
  assert.equal(engineIsIdle(managerStub('starting')), false)
  assert.equal(engineIsIdle(managerStub('stopping')), false)
})

test('UpdateChecker.checkAll + prune', async () => {
  const a = eng({ id: 'a', kind: 'mlx', version: 'mlx-lm 0.1.0' })
  const b = eng({ id: 'b', kind: 'vllm', version: 'vllm 0.1.0' })
  const checker = new UpdateChecker(async (src: ResolvedSource) => (src.ref === 'mlx-lm' ? '0.2.0' : '0.1.0'))
  const all = await checker.checkAll([a, b])
  assert.equal(all.a.hasUpdate, true)
  assert.equal(all.b.hasUpdate, false)
  checker.prune(new Set(['a']))
  assert.equal(checker.get('a') !== undefined, true)
  assert.equal(checker.get('b'), undefined)
})
