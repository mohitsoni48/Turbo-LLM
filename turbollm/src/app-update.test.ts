import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compareAppVersions,
  computeAppUpdateStatus,
  AppUpdateChecker,
  APP_UPDATE_CHECK_INTERVAL_MS,
} from './app-update'

// ─── version comparison ──────────────────────────────────────────────────────

test('compareAppVersions: newer / equal / older (latest perspective)', () => {
  assert.equal(compareAppVersions('1.0.0', '1.1.0'), 'newer') // npm ahead → update available
  assert.equal(compareAppVersions('1.0.0', '1.0.0'), 'equal')
  assert.equal(compareAppVersions('1.1.0', '1.0.0'), 'older') // running a dev build ahead of npm
  assert.equal(compareAppVersions('1.0.0', '1.0.1'), 'newer')
  assert.equal(compareAppVersions('0.9.0', '1.0.0'), 'newer')
})

test('compareAppVersions: tolerates leading v and ignores pre-release suffixes', () => {
  assert.equal(compareAppVersions('v1.0.0', 'v1.1.0'), 'newer')
  // pre-release suffix ignored: 1.1.0-rc1 reads as 1.1.0
  assert.equal(compareAppVersions('1.0.0', '1.1.0-rc1'), 'newer')
})

// ─── computeAppUpdateStatus ──────────────────────────────────────────────────

test('computeAppUpdateStatus: latest ahead → hasUpdate true', async () => {
  const s = await computeAppUpdateStatus('1.0.0', async () => '1.1.0')
  assert.equal(s.installed, '1.0.0')
  assert.equal(s.latest, '1.1.0')
  assert.equal(s.hasUpdate, true)
  assert.equal(s.comparable, true)
  assert.equal(s.error, undefined)
  assert.ok(s.checkedAt)
})

test('computeAppUpdateStatus: equal version → no update', async () => {
  const s = await computeAppUpdateStatus('1.0.0', async () => '1.0.0')
  assert.equal(s.hasUpdate, false)
  assert.equal(s.comparable, true)
})

test('computeAppUpdateStatus: running ahead of npm (local dev) → no update', async () => {
  const s = await computeAppUpdateStatus('1.2.0', async () => '1.1.0')
  assert.equal(s.hasUpdate, false)
  assert.equal(s.comparable, true)
})

test('computeAppUpdateStatus: fetch throws → offline, never a fabricated latest', async () => {
  const s = await computeAppUpdateStatus('1.0.0', async () => {
    throw new Error('network down')
  })
  assert.equal(s.latest, null)
  assert.equal(s.hasUpdate, false)
  assert.equal(s.error, 'offline')
  assert.equal(s.comparable, false)
  assert.equal(s.installed, '1.0.0')
})

test('computeAppUpdateStatus: empty latest → offline (no false up-to-date)', async () => {
  const s = await computeAppUpdateStatus('1.0.0', async () => '')
  assert.equal(s.latest, null)
  assert.equal(s.error, 'offline')
  assert.equal(s.hasUpdate, false)
})

// ─── AppUpdateChecker (cache + TTL + offline-keeps-prior) ─────────────────────

test('AppUpdateChecker: caches the last status', async () => {
  const checker = new AppUpdateChecker('1.0.0', async () => '1.1.0')
  assert.equal(checker.get(), null)
  const s = await checker.check()
  assert.equal(s.hasUpdate, true)
  assert.equal(checker.get()?.latest, '1.1.0')
})

test('AppUpdateChecker: an offline re-check keeps a prior successful answer', async () => {
  let online = true
  const checker = new AppUpdateChecker('1.0.0', async () => {
    if (!online) throw new Error('offline')
    return '1.1.0'
  })
  await checker.check()
  online = false
  const s = await checker.check()
  // Still the real latest, not a flap to "couldn't check".
  assert.equal(s.latest, '1.1.0')
  assert.equal(s.hasUpdate, true)
  assert.equal(s.error, undefined)
})

test('AppUpdateChecker: with no prior success, an offline result is cached as offline', async () => {
  const checker = new AppUpdateChecker('1.0.0', async () => {
    throw new Error('offline')
  })
  const s = await checker.check()
  assert.equal(s.error, 'offline')
  assert.equal(checker.get()?.error, 'offline')
})

test('AppUpdateChecker.isStale: stale before any check, fresh right after, stale past TTL', async () => {
  const checker = new AppUpdateChecker('1.0.0', async () => '1.0.0')
  assert.equal(checker.isStale(), true) // never checked
  await checker.check()
  const at = Date.parse(checker.get()!.checkedAt)
  assert.equal(checker.isStale(at + 1000), false) // 1s later → fresh
  assert.equal(checker.isStale(at + APP_UPDATE_CHECK_INTERVAL_MS), true) // 24h later → stale
})
